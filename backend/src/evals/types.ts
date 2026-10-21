import type { ToolCallLog } from "../agent.js";

export type EvalCategory =
  | "data_lookup"
  | "what_if"
  | "unit_scale"
  | "multi_step"
  | "out_of_scope"
  | "proposal_tools"
  | "guardrails";

export type CheckResult = { pass: boolean; detail: string };

export type EvalCase = {
  name: string;
  category: EvalCategory;
  message: string;
  check: (toolCalls: ToolCallLog[], reply: string) => CheckResult;
};

export type CaseAggregate = {
  name: string;
  category: EvalCategory;
  passes: number;
  runs: number;
  passRate: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  avgLatencyMs: number;
  /** One entry per failing run, in run order -- empty when passRate is 1. */
  failureDetails: string[];
};

export type ModelReport = {
  catalogId: string;
  vendor: string;
  vendorModelId: string;
  cases: CaseAggregate[];
  overallPassRate: number;
  categoryPassRates: Partial<Record<EvalCategory, number>>;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** null when this vendor/model isn't in the pricing table yet -- see
   *  llm/anthropic/pricing.ts. Reported as "n/a", never guessed. */
  avgCostUsd: number | null;
  p50LatencyMs: number;
  p95LatencyMs: number;
};
