/**
 * Provider-agnostic conversation/tool-calling types. agent.ts operates only
 * on these -- it never imports an SDK directly. Swapping vendors means
 * writing one new file implementing LlmProvider, not touching the loop.
 */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  // Some providers produce extra content with no cross-vendor meaning (e.g.
  // Anthropic's extended-thinking blocks, which must be replayed verbatim
  // back to the SAME provider or the API rejects the next call -- see the
  // SDK-upgrade fix in git history). Carried opaquely: agent.ts stores and
  // replays it without interpreting it, and it only ever round-trips to the
  // provider that produced it, since a provider is fixed for one runAgent()
  // call and `history` passed between calls is always plain text.
  | { type: "opaque"; raw: unknown };

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string | ContentBlock[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type CompletionRequest = {
  system: string;
  tools: ToolDefinition[];
  messages: ConversationMessage[];
  maxTokens: number;
};

export type CompletionResult = {
  content: ContentBlock[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
};

export interface LlmProvider {
  readonly id: string;
  /** A tested, code-owned value -- different models need very different
   *  budgets (e.g. extended-thinking models need far more). */
  readonly defaultMaxTokens: number;
  streamComplete(
    request: CompletionRequest,
    onTextDelta: (delta: string) => void
  ): Promise<CompletionResult>;
}

/** The one vendor-agnostic signal agent.ts needs to decide whether to
 *  retry a failed streamComplete() call -- without knowing which SDK or
 *  error class it came from. A provider implementation classifies its own
 *  vendor's transient errors (rate limits, overloads, timeouts) and
 *  re-throws them as this; anything else propagates as-is and is treated
 *  as non-retryable. */
export class RetryableLlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RetryableLlmError";
  }
}
