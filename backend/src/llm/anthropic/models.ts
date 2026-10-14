/**
 * Known Anthropic model IDs this app has been tested against, and the
 * max_tokens budget found safe for each. These are tested facts about a
 * model's behavior (e.g. Sonnet's extended thinking silently exhausted a
 * too-small budget and returned empty replies at 1024 tokens; 4096 fixed
 * it), not an admin preference -- so they live here, not in the llm_models
 * DB catalog, where a casual UI entry could reintroduce that exact bug.
 *
 * The catalog can still reference a model_id that isn't listed here (e.g.
 * someone adds a brand new model via the admin UI) -- that fails loudly
 * when activated, rather than silently guessing a budget. Add an entry
 * here, tested, before activating a new model.
 */
const MODEL_MAX_TOKENS: Record<string, number> = {
  "claude-haiku-4-5-20251001": 1024,
  "claude-sonnet-5": 4096,
};

export function getMaxTokensForModel(modelId: string): number {
  const maxTokens = MODEL_MAX_TOKENS[modelId];
  if (maxTokens === undefined) {
    throw new Error(
      `No known max_tokens default for Anthropic model "${modelId}". ` +
        "Add it to llm/anthropic/models.ts (tested, not guessed) before activating this model."
    );
  }
  return maxTokens;
}
