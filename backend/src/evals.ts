/**
 * Eval suite CLI entrypoint. Golden questions run against the REAL agent
 * loop -- real API calls, costs credits, takes time. Case definitions live
 * in evals/cases.ts, orchestration (model switching, N-runs-per-case,
 * aggregation) in evals/runner.ts, output in evals/report.ts -- this file
 * just parses args and wires them together.
 *
 * Run manually: npm run evals (backend/)
 *   -- --models <id,id,...>  llm_models catalog ids to compare (default: whichever is active)
 *   -- --runs <N>              times to run each case per model, for consistency (default 3)
 *   -- --category <name>       only run cases in this category (cheap iteration while adding cases)
 *   -- --dry-run                 list cases without calling the API
 *
 * When to run: after changing the system prompt, a tool's schema/description,
 * the model, or the token/iteration caps -- NOT on every live chat request.
 * This is a regression check for agent behavior, not something the app
 * consults while answering a real question.
 *
 * Each case is tied to a specific bug hit during development, or (for the
 * out-of-scope/guardrail categories) a specific risk the approvals system
 * is meant to catch -- so a failure here means a known regression came
 * back, not a novel one.
 */
import "dotenv/config";
import { initDatabase, pool } from "./db.js";
import { listLlmModels } from "./data.js";
import { getTool } from "./tools.js";
import { buildCases } from "./evals/cases.js";
import { runSuite } from "./evals/runner.js";
import { writeResults } from "./evals/report.js";
import type { EvalCategory } from "./evals/types.js";

async function callTool(name: string, args: unknown): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(tool.inputSchema.parse(args));
}

type Args = {
  models: string[] | null;
  runs: number;
  category: EvalCategory | null;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  let models: string[] | null = null;
  let runs = 3;
  let category: EvalCategory | null = null;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--models") {
      models = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--runs") {
      runs = Number(argv[++i]);
      if (!Number.isInteger(runs) || runs < 1) {
        throw new Error(`--runs must be a positive integer`);
      }
    } else if (arg === "--category") {
      category = argv[++i] as EvalCategory;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }
  return { models, runs, category, dryRun };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  await initDatabase();

  // Ground truth pulled from the real tools -- same code path the agent
  // uses, so cases stay valid as the user's actual saved data changes.
  const portfolio = (await callTool("get_portfolio", {})) as {
    settings: { start_age: number; end_age: number };
  };
  const buckets = (await callTool("get_buckets", {})) as { name: string; asset_class: string }[];
  const groundTruth = {
    startAge: portfolio.settings.start_age,
    equityBucketNames: buckets.filter((b) => b.asset_class === "equity").map((b) => b.name),
    debtBucketNames: buckets.filter((b) => b.asset_class === "debt").map((b) => b.name),
  };

  let cases = buildCases(groundTruth);
  if (args.category) {
    cases = cases.filter((c) => c.category === args.category);
    if (cases.length === 0) {
      throw new Error(`No cases in category "${args.category}"`);
    }
  }

  if (args.dryRun) {
    console.log(`${cases.length} case(s):\n`);
    for (const c of cases) {
      console.log(`[${c.category}] ${c.name}\n      "${c.message}"\n`);
    }
    await pool.end();
    return;
  }

  const allModels = await listLlmModels();
  const catalogIds = args.models ?? allModels.filter((m) => m.is_active).map((m) => m.id);
  if (catalogIds.length === 0) {
    throw new Error("No active model found, and --models wasn't given.");
  }

  const totalCalls = cases.length * args.runs * catalogIds.length;
  console.log(
    `Running ${cases.length} case(s) x ${args.runs} run(s) x ${catalogIds.length} model(s) ` +
      `= ${totalCalls} agent call(s)...\n`
  );

  const reports = await runSuite({ catalogIds, runsPerCase: args.runs, cases });

  const { jsonPath, mdPath, markdown } = writeResults(reports);

  let anyFailed = false;
  for (const r of reports) {
    console.log(`\n=== ${r.catalogId} ===`);
    for (const c of r.cases) {
      const status = c.passRate === 1 ? "PASS" : c.passRate === 0 ? "FAIL" : "FLAKY";
      if (c.passRate < 1) anyFailed = true;
      console.log(`${status}  ${c.name} (${c.passes}/${c.runs})`);
      for (const detail of c.failureDetails) {
        console.log(`      ${detail}`);
      }
    }
  }

  console.log(`\n${markdown}`);
  console.log(`Written to ${jsonPath} and ${mdPath}\n`);

  await pool.end();
  if (anyFailed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
