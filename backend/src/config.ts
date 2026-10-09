/**
 * Deliberately NOT named ANTHROPIC_API_KEY: Claude Code reads that variable
 * from the shell and would bill this app's usage against your Pro login
 * instead of using Pro. Keep it namespaced to this app and backend-only.
 */
export const LLM_API_KEY = process.env.PORTFOLIO_LLM_API_KEY ?? "";

export const LLM_MODEL = process.env.PORTFOLIO_LLM_MODEL ?? "claude-haiku-4-5-20251001";

export const AGENT_MAX_ITERATIONS = Number(process.env.AGENT_MAX_ITERATIONS ?? 6);

// Thinking tokens count against this same budget for models with extended
// thinking (e.g. Sonnet). Too low and the model can exhaust the whole
// budget mid-thought, returning zero visible text with no error.
export const AGENT_MAX_TOKENS_PER_CALL = Number(
  process.env.AGENT_MAX_TOKENS_PER_CALL ?? 4096
);
