import { loadActiveLlmModel } from "../data.js";
import { createAnthropicProvider } from "./anthropic/provider.js";
import type { LlmProvider } from "./types.js";

/**
 * One factory per vendor IMPLEMENTATION (code). Which specific models of
 * that vendor exist, their labels, and which one is active are all data --
 * see the llm_models table. Adding a model of an already-supported vendor
 * is a DB row (+ a code-level max_tokens entry, see anthropic/models.ts);
 * adding a genuinely new vendor means writing one more factory like this
 * and adding it here -- agent.ts doesn't change either way.
 */
type VendorFactory = (opts: { id: string; model: string }) => LlmProvider;

const VENDOR_FACTORIES: Record<string, VendorFactory> = {
  anthropic: createAnthropicProvider,
};

export function listVendors(): string[] {
  return Object.keys(VENDOR_FACTORIES);
}

export async function getActiveProvider(): Promise<LlmProvider> {
  const model = await loadActiveLlmModel();
  if (!model) {
    throw new Error(
      "No active LLM model configured -- set one via PUT /api/llm-models/:id/activate"
    );
  }
  const factory = VENDOR_FACTORIES[model.vendor];
  if (!factory) {
    throw new Error(
      `No provider implementation for vendor "${model.vendor}". Known vendors: ${listVendors().join(", ")}`
    );
  }
  return factory({ id: model.id, model: model.model_id });
}
