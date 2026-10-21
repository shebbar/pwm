import { activateLlmModel, listLlmModels, type LlmModelRow } from "../data.js";
import { runAgent } from "../agent.js";
import { estimateCostUsd } from "../llm/anthropic/pricing.js";
import type { CaseAggregate, EvalCase, EvalCategory, ModelReport } from "./types.js";

export type RunnerOptions = {
  catalogIds: string[];
  runsPerCase: number;
  cases: EvalCase[];
};

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

/** Only Anthropic has a pricing table today (see llm/anthropic/pricing.ts).
 *  A model from a vendor without one reports null cost rather than a
 *  guessed number -- Phase 4 is where this grows into a real per-vendor
 *  dispatch, same shape as llm/registry.ts's vendor -> factory map. */
function estimateCost(vendor: string, vendorModelId: string, inputTokens: number, outputTokens: number): number | null {
  if (vendor !== "anthropic") return null;
  try {
    return estimateCostUsd(vendorModelId, inputTokens, outputTokens);
  } catch {
    return null;
  }
}

type RunOutcome = {
  pass: boolean;
  detail: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

async function runCaseOnce(c: EvalCase): Promise<RunOutcome> {
  const start = Date.now();
  try {
    const result = await runAgent(c.message, [], () => {});
    const { pass, detail } = c.check(result.toolCalls, result.reply);
    return { pass, detail, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      pass: false,
      detail: `threw: ${err instanceof Error ? err.message : String(err)}`,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - start,
    };
  }
}

async function runForModel(model: LlmModelRow, cases: EvalCase[], runsPerCase: number): Promise<ModelReport> {
  const caseAggregates: CaseAggregate[] = [];
  const allLatencies: number[] = [];
  const categoryTotals = new Map<EvalCategory, { passes: number; runs: number }>();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let costKnown = true;
  let totalPasses = 0;
  let totalRuns = 0;

  for (const c of cases) {
    let passes = 0;
    const failureDetails: string[] = [];
    let caseInput = 0;
    let caseOutput = 0;
    const caseLatencies: number[] = [];

    for (let i = 0; i < runsPerCase; i++) {
      const outcome = await runCaseOnce(c);
      if (outcome.pass) passes++;
      else failureDetails.push(outcome.detail);

      caseInput += outcome.inputTokens;
      caseOutput += outcome.outputTokens;
      caseLatencies.push(outcome.latencyMs);
      allLatencies.push(outcome.latencyMs);
      totalInput += outcome.inputTokens;
      totalOutput += outcome.outputTokens;

      const cost = estimateCost(model.vendor, model.model_id, outcome.inputTokens, outcome.outputTokens);
      if (cost === null) costKnown = false;
      else totalCost += cost;
    }

    totalPasses += passes;
    totalRuns += runsPerCase;
    const catTotal = categoryTotals.get(c.category) ?? { passes: 0, runs: 0 };
    catTotal.passes += passes;
    catTotal.runs += runsPerCase;
    categoryTotals.set(c.category, catTotal);

    caseAggregates.push({
      name: c.name,
      category: c.category,
      passes,
      runs: runsPerCase,
      passRate: passes / runsPerCase,
      avgInputTokens: caseInput / runsPerCase,
      avgOutputTokens: caseOutput / runsPerCase,
      avgLatencyMs: caseLatencies.reduce((a, b) => a + b, 0) / runsPerCase,
      failureDetails,
    });
  }

  const sortedLatencies = [...allLatencies].sort((a, b) => a - b);
  const categoryPassRates: Partial<Record<EvalCategory, number>> = {};
  for (const [cat, t] of categoryTotals) categoryPassRates[cat] = t.passes / t.runs;

  return {
    catalogId: model.id,
    vendor: model.vendor,
    vendorModelId: model.model_id,
    cases: caseAggregates,
    overallPassRate: totalRuns > 0 ? totalPasses / totalRuns : 0,
    categoryPassRates,
    avgInputTokens: totalRuns > 0 ? totalInput / totalRuns : 0,
    avgOutputTokens: totalRuns > 0 ? totalOutput / totalRuns : 0,
    avgCostUsd: costKnown && totalRuns > 0 ? totalCost / totalRuns : null,
    p50LatencyMs: percentile(sortedLatencies, 50),
    p95LatencyMs: percentile(sortedLatencies, 95),
  };
}

/** Switches the active model for each requested catalog id, runs the full
 *  case suite against it, then restores whichever model was active before
 *  this call -- running evals must never leave the app answering real chat
 *  requests with a different model than before the run. Restoration runs
 *  in a finally so a mid-suite throw still leaves the app on the right model. */
export async function runSuite(opts: RunnerOptions): Promise<ModelReport[]> {
  const allModels = await listLlmModels();
  const originallyActive = allModels.find((m) => m.is_active);

  const targets: LlmModelRow[] = opts.catalogIds.map((id) => {
    const found = allModels.find((m) => m.id === id);
    if (!found) {
      throw new Error(`Unknown model id "${id}" -- known ids: ${allModels.map((m) => m.id).join(", ")}`);
    }
    return found;
  });

  const reports: ModelReport[] = [];
  try {
    for (const model of targets) {
      await activateLlmModel(model.id);
      reports.push(await runForModel(model, opts.cases, opts.runsPerCase));
    }
  } finally {
    if (originallyActive) {
      await activateLlmModel(originallyActive.id);
    }
  }
  return reports;
}
