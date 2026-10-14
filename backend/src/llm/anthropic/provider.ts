import Anthropic from "@anthropic-ai/sdk";
import { LLM_API_KEY } from "../../config.js";
import type {
  CompletionRequest,
  CompletionResult,
  ContentBlock,
  ConversationMessage,
  LlmProvider,
} from "../types.js";
import { getMaxTokensForModel } from "./models.js";

function toAnthropicContentBlock(b: ContentBlock): Anthropic.ContentBlockParam {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") {
    return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  }
  if (b.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: b.toolUseId,
      content: b.content,
      is_error: b.isError,
    };
  }
  // opaque -- this block only ever came from this same provider, so handing
  // it back unmodified is exactly what it needs.
  return b.raw as Anthropic.ContentBlockParam;
}

function toAnthropicMessage(m: ConversationMessage): Anthropic.MessageParam {
  if (typeof m.content === "string") {
    return { role: m.role, content: m.content };
  }
  return { role: m.role, content: m.content.map(toAnthropicContentBlock) };
}

function fromAnthropicBlock(b: Anthropic.ContentBlock): ContentBlock {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") {
    return { type: "tool_use", id: b.id, name: b.name, input: b.input };
  }
  return { type: "opaque", raw: b };
}

/** opts.model is a raw Anthropic model ID (llm_models.model_id); its
 *  max_tokens default comes from the tested table in ./models.ts, not from
 *  the caller -- see that file for why. */
export function createAnthropicProvider(opts: { id: string; model: string }): LlmProvider {
  const client = new Anthropic({ apiKey: LLM_API_KEY });
  const defaultMaxTokens = getMaxTokensForModel(opts.model);

  return {
    id: opts.id,
    defaultMaxTokens,
    async streamComplete(
      request: CompletionRequest,
      onTextDelta: (delta: string) => void
    ): Promise<CompletionResult> {
      const stream = client.messages.stream({
        model: opts.model,
        max_tokens: request.maxTokens,
        system: request.system,
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema as unknown as Anthropic.Tool.InputSchema,
        })),
        messages: request.messages.map(toAnthropicMessage),
      });

      stream.on("text", onTextDelta);

      const final = await stream.finalMessage();
      
      return {
        content: final.content.map(fromAnthropicBlock),
        stopReason: final.stop_reason,
        usage: {
          inputTokens: final.usage.input_tokens,
          outputTokens: final.usage.output_tokens,
        },
      };
    },
  };
}
