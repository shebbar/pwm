import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AGENT_MAX_ITERATIONS,
  AGENT_MAX_TOKENS_PER_CALL,
  LLM_API_KEY,
  LLM_MODEL,
} from "./config.js";
import { tools, type Tool } from "./tools.js";

const anthropic = new Anthropic({ apiKey: LLM_API_KEY });

const SYSTEM_PROMPT = `You are a financial planning assistant inside a personal
retirement-projection app. All amounts are in INR Lakhs (1 Lakh = 100,000).

You have read-only tools that query the user's real saved plan and run the
deterministic projection engine. Never compute a projection, corpus value, or
depletion age yourself -- always call run_projection (optionally with
hypothetical "assumptions" and a "horizon") for any numeric answer about the
plan. Use get_portfolio/get_buckets/get_expenses to look up current data
before reasoning about it.

This session only has read tools. If asked to change saved data (update an
assumption, add an expense), explain that writes aren't supported from chat
yet and that the change would need to be made in the admin screen.`;

// This first agent is deliberately read-only -- write tools require an
// approval-gate UI that doesn't exist yet, so they're not offered to the
// model at all rather than relying on it to ask first.
const AGENT_TOOLS: Tool[] = tools.filter((t) => t.kind === "read");

const anthropicTools: Anthropic.Tool[] = AGENT_TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: zodToJsonSchema(t.inputSchema, {
    $refStrategy: "none",
  }) as unknown as Anthropic.Tool.InputSchema,
}));

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: unknown };

export type ToolCallLog = { name: string; input: unknown; output: unknown };

export type AgentResult = {
  reply: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: ToolCallLog[];
};

export async function runAgent(
  userMessage: string,
  history: ChatTurn[],
  onEvent: (event: AgentEvent) => void
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [
    ...history.map(
      (h): Anthropic.MessageParam => ({ role: h.role, content: h.content })
    ),
    { role: "user", content: userMessage },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: ToolCallLog[] = [];

  for (let iteration = 0; iteration < AGENT_MAX_ITERATIONS; iteration++) {
    const stream = anthropic.messages.stream({
      model: LLM_MODEL,
      max_tokens: AGENT_MAX_TOKENS_PER_CALL,
      system: SYSTEM_PROMPT,
      tools: anthropicTools,
      messages,
    });

    stream.on("text", (textDelta) => {
      onEvent({ type: "delta", text: textDelta });
    });

    const final = await stream.finalMessage();
    inputTokens += final.usage.input_tokens;
    outputTokens += final.usage.output_tokens;
    messages.push({ role: "assistant", content: final.content });

    const toolUseBlocks = final.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUseBlocks.length === 0) {
      const reply = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!reply.trim()) {
        // Model stopped without producing any visible text (commonly: it
        // used its whole max_tokens budget on thinking). Surface this as a
        // real error instead of silently returning nothing -- a "successful"
        // empty reply is worse than an explicit failure.
        throw new Error(
          `Model returned no text (stop_reason: ${final.stop_reason ?? "unknown"}). ` +
            "This usually means it ran out of its token budget while thinking -- try AGENT_MAX_TOKENS_PER_CALL higher, or a simpler question."
        );
      }
      return { reply, inputTokens, outputTokens, toolCalls };
    }

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
   
    for (const block of toolUseBlocks) {
      onEvent({ type: "tool_call", name: block.name, input: block.input });
      let output: unknown;
      let isError = false;
      try {
        const tool = AGENT_TOOLS.find((t) => t.name === block.name);
        if (!tool) throw new Error(`Unknown tool: ${block.name}`);
        const parsedInput = tool.inputSchema.parse(block.input);
        output = await tool.handler(parsedInput);
      } catch (err) {
        isError = true;
        output = { error: err instanceof Error ? err.message : "Tool failed" };
      }

      onEvent({ type: "tool_result", name: block.name, output });
      toolCalls.push({ name: block.name, input: block.input, output });
      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(output),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(
    `Agent exceeded ${AGENT_MAX_ITERATIONS} tool-call iterations without a final answer`
  );
}
