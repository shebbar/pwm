/**
 * Eval suite: golden questions with ground truth computed from the same
 * deterministic engine/tools the agent uses, run against the REAL agent
 * loop (real API calls -- costs credits, takes time).
 *
 * Run manually: npm run evals (backend/)
 *
 * When to run: after changing the system prompt, a tool's schema/description,
 * the model, or the token/iteration caps -- NOT on every live chat request.
 * This is a regression check for agent behavior, not something the app
 * consults while answering a real question.
 *
 * Each case is tied to a specific bug hit during development, so a failure
 * here means a known regression came back, not a novel one.
 */
import "dotenv/config";
import { initDatabase, pool } from "./db.js";
import { runAgent, type ToolCallLog } from "./agent.js";
import { getActiveProvider } from "./llm/registry.js";
import { getTool } from "./tools.js";

type CheckResult = { pass: boolean; detail: string };
type EvalResult = { name: string; pass: boolean; detail: string };

async function callTool(name: string, args: unknown): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  return tool.handler(tool.inputSchema.parse(args));
}

function findCalls(toolCalls: ToolCallLog[], name: string): ToolCallLog[] {
  return toolCalls.filter((t) => t.name === name);
}

async function main(): Promise<void> {
  await initDatabase();

  // Ground truth pulled from the real tools -- same code path the agent
  // uses, so these stay valid as the user's actual saved data changes.
  const portfolio = (await callTool("get_portfolio", {})) as {
    settings: { start_age: number; end_age: number };
  };
  const buckets = (await callTool("get_buckets", {})) as {
    name: string;
    asset_class: string;
  }[];
  const equityBucketNames = buckets
    .filter((b) => b.asset_class === "equity")
    .map((b) => b.name);
  const debtBucketNames = buckets
    .filter((b) => b.asset_class === "debt")
    .map((b) => b.name);
  const { start_age } = portfolio.settings;

  const results: EvalResult[] = [];

  async function evalCase(
    name: string,
    message: string,
    check: (toolCalls: ToolCallLog[], reply: string) => CheckResult
  ): Promise<void> {
    try {
      const result = await runAgent(message, [], () => {});
      results.push({ name, ...check(result.toolCalls, result.reply) });
    } catch (err) {
      results.push({
        name,
        pass: false,
        detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Regression: nothing enforced the agent actually look up real data
  // instead of answering from its own training-data assumptions.
  await evalCase(
    "reads total corpus from get_portfolio instead of guessing",
    "What's my current total corpus and weighted average return?",
    (toolCalls) => {
      const calls = findCalls(toolCalls, "get_portfolio");
      return {
        pass: calls.length > 0,
        detail:
          calls.length > 0
            ? `called get_portfolio ${calls.length}x`
            : "never called get_portfolio",
      };
    }
  );

  // Regression: "Rs 1 lakh/month" got translated to monthly_amount_lakhs: 0.1
  // (a 10x unit error) instead of 1, since the app's amounts are already in lakhs.
  await evalCase(
    "SWP monthly amount uses the correct scale (lakhs, not rupees/10)",
    `Ignore my saved SWP plan. If I withdraw a flat Rs 1 lakh per month from age ${start_age} to 90, at what age does my corpus run out?`,
    (toolCalls) => {
      const calls = findCalls(toolCalls, "run_projection");
      const withOverride = calls.find((c) => {
        const input = c.input as { assumptions?: { swp_override?: unknown[] } };
        return (input.assumptions?.swp_override?.length ?? 0) > 0;
      });
      if (!withOverride) {
        return { pass: false, detail: "never called run_projection with swp_override" };
      }
      const input = withOverride.input as {
        assumptions: { swp_override: { monthly_amount_lakhs: number }[] };
      };
      const amounts = input.assumptions.swp_override.map((p) => p.monthly_amount_lakhs);
      const badScale = amounts.some((a) => a < 0.5 || a > 2);
      return {
        pass: !badScale,
        detail: `swp_override monthly amounts: ${JSON.stringify(amounts)} (expected ~1)`,
      };
    }
  );

  // Regression: "increase all equity returns" only touched the bucket literally
  // named "Equity MF", missing "Orchid MF" -- a bucket name doesn't reliably
  // indicate asset class, asset_class does.
  await evalCase(
    "equity-return change covers every equity-class bucket (by asset_class, not name)",
    "What if I increase all my equity fund returns to 12%?",
    (toolCalls) => {
      const calls = findCalls(toolCalls, "run_projection");
      const withOverride = calls.find((c) => {
        const input = c.input as { assumptions?: { bucket_overrides?: unknown[] } };
        return (input.assumptions?.bucket_overrides?.length ?? 0) > 0;
      });
      if (!withOverride) {
        return { pass: false, detail: "never called run_projection with bucket_overrides" };
      }
      const input = withOverride.input as {
        assumptions: { bucket_overrides: { name: string; return_pct?: number }[] };
      };
      const touched = new Set(
        input.assumptions.bucket_overrides
          .filter((o) => o.return_pct === 12)
          .map((o) => o.name)
      );
      const missing = equityBucketNames.filter((n) => !touched.has(n));
      return {
        pass: missing.length === 0,
        detail:
          missing.length === 0
            ? `all equity buckets covered: ${equityBucketNames.join(", ")}`
            : `missing equity buckets: ${missing.join(", ")}`,
      };
    }
  );

  // Core "LLM never does the math" invariant: a what-if must always go
  // through run_projection with the actual override, never be answered
  // from the model's own estimate.
  await evalCase(
    "hypothetical inflation change always calls run_projection with the override",
    "If inflation were 7% instead of my current assumption, would my corpus last until 90?",
    (toolCalls) => {
      const calls = findCalls(toolCalls, "run_projection");
      const withInflation = calls.find((c) => {
        const input = c.input as { assumptions?: { inflation_pct?: number } };
        return input.assumptions?.inflation_pct === 7;
      });
      return {
        pass: Boolean(withInflation),
        detail: withInflation
          ? "called run_projection with inflation_pct: 7"
          : `no run_projection call used inflation_pct: 7 (calls: ${JSON.stringify(
              calls.map((c) => c.input)
            )})`,
      };
    }
  );

  // Regression: asked to set two debt buckets to an explicit 5%, one
  // proposal came back as 4.2% (6% * 0.7 -- a post-tax adjustment the
  // model invented on its own, matching a calculation it had made in an
  // unrelated earlier session) while the other correctly used 5%. The
  // guardrail (-5 to 30) didn't catch it since 4.2 is a perfectly sane
  // return_pct on its own -- this is an instruction-fidelity bug, not a
  // guardrail-catchable one. Re-running the identical prompt produced the
  // correct value both times, consistent with multi-tool-call sampling
  // variance rather than a deterministic bug.
  await evalCase(
    "explicit numeric value used exactly across every bucket proposal in a turn",
    "Can you propose lowering the return rate on both of my debt buckets to exactly 5%?",
    (toolCalls) => {
      const calls = findCalls(toolCalls, "propose_update_assumption").filter((c) => {
        const input = c.input as { kind?: string; field?: string };
        return input.kind === "bucket" && input.field === "return_pct";
      });
      const proposedByBucket = new Map(
        calls.map((c) => {
          const input = c.input as { bucket_name: string; value: number };
          return [input.bucket_name, input.value] as const;
        })
      );
      const missing = debtBucketNames.filter((n) => !proposedByBucket.has(n));
      const wrongValue = [...proposedByBucket.entries()].filter(([, v]) => v !== 5);
      const pass = missing.length === 0 && wrongValue.length === 0;
      return {
        pass,
        detail: pass
          ? `all debt buckets proposed at exactly 5%: ${debtBucketNames.join(", ")}`
          : `missing proposals: ${JSON.stringify(missing)}, wrong values: ${JSON.stringify(wrongValue)}`,
      };
    }
  );

  const activeProvider = await getActiveProvider();
  console.log(`\nEvals run against provider: ${activeProvider.id}\n`);
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n      ${r.detail}\n`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`${results.length - failed.length}/${results.length} passed`);

  await pool.end();
  if (failed.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
