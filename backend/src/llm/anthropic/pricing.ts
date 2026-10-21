/**
 * USD price per model, in dollars per token (not per million) so callers
 * can multiply directly by a token count without a second conversion step.
 * Source: Anthropic's published per-million-token rates, checked against
 * the live rate card rather than guessed -- same "tested fact in code, not
 * a casual DB/UI field" philosophy as models.ts's max_tokens table. Prices
 * change over time (e.g. introductory rates expiring); these are a
 * snapshot, not a live lookup -- update them here when they change, the
 * same way a new model's max_tokens gets added.
 *
 * Scoped to just what evals.ts needs for its "average cost per question"
 * column (Phase 3). A fuller per-vendor price table (INR conversion, more
 * vendors, admin-visible rate history) is Phase 4 (Observability)
 * territory -- this file is deliberately minimal so that work extends it
 * rather than redoing it.
 */
const MODEL_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0 / 1_000_000, output: 5.0 / 1_000_000 },
  "claude-sonnet-5": { input: 3.0 / 1_000_000, output: 15.0 / 1_000_000 },
};

export function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  const rate = MODEL_USD_PER_TOKEN[modelId];
  if (!rate) {
    throw new Error(
      `No known USD pricing for Anthropic model "${modelId}". ` +
        "Add it to llm/anthropic/pricing.ts (checked against the published rate card) before costing this model's evals."
    );
  }
  return inputTokens * rate.input + outputTokens * rate.output;
}
