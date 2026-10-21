import { listLlmModels, loadActiveLlmModel, type LlmModelRow } from "../data.js";
import { createAnthropicProvider } from "./anthropic/provider.js";
import { estimateCostUsd as estimateAnthropicCostUsd } from "./anthropic/pricing.js";
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

function buildProvider(model: LlmModelRow): LlmProvider {
  const factory = VENDOR_FACTORIES[model.vendor];
  if (!factory) {
    throw new Error(
      `No provider implementation for vendor "${model.vendor}". Known vendors: ${listVendors().join(", ")}`
    );
  }
  return factory({ id: model.id, model: model.model_id });
}

export async function getActiveProvider(): Promise<LlmProvider> {
  const model = await loadActiveLlmModel();
  if (!model) {
    throw new Error(
      "No active LLM model configured -- set one via PUT /api/llm-models/:id/activate"
    );
  }
  return buildProvider(model);
}

/**
 * Resolves which model runCritic (agent.ts) should use. Prefers the
 * explicit is_critic pick, but a critic is never allowed to run on the same
 * model as the active chat agent unless that's literally the only model in
 * the catalog -- re-checked here (not just at set time in
 * activateCriticLlmModel) so this stays correct even if the active model
 * changes later and happens to collide with a previously-set critic pick.
 * That collision is handled by silently falling back to a different
 * available model, not by erroring -- the critic running on a slightly
 * different model than the admin explicitly chose is a minor surprise, not
 * a failure worth interrupting a "second opinion" button click over.
 */
export async function getCriticProvider(): Promise<LlmProvider> {
  const models = await listLlmModels();
  const active = models.find((m) => m.is_active);
  if (!active) {
    throw new Error(
      "No active LLM model configured -- set one via PUT /api/llm-models/:id/activate"
    );
  }
  const explicitCritic = models.find((m) => m.is_critic);
  const critic =
    (explicitCritic && explicitCritic.id !== active.id ? explicitCritic : null) ??
    models.find((m) => m.id !== active.id) ??
    active;
  return buildProvider(critic);
}

/** Vendor -> pricing-table dispatch, mirroring VENDOR_FACTORIES above.
 *  Returns null rather than throwing for a vendor with no pricing table
 *  yet (there's only one today) or a model missing from that vendor's
 *  table -- an unknown cost should show as "n/a", never a guessed number. */
export function estimateCostUsd(
  vendor: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number | null {
  if (vendor !== "anthropic") return null;
  try {
    return estimateAnthropicCostUsd(modelId, inputTokens, outputTokens);
  } catch {
    return null;
  }
}
