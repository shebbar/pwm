import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AGENT_MAX_ITERATIONS, MCP_AUTH_TOKEN, MCP_SERVER_URL } from "./config.js";
import { getActiveProvider } from "./llm/registry.js";
import type { CompletionRequest, ContentBlock, ConversationMessage } from "./llm/types.js";

const SYSTEM_PROMPT = `You are a financial planning assistant inside a personal
retirement-projection app. All amounts are in INR Lakhs (1 Lakh = 100,000).

You have read-only tools that query the user's real saved plan and run the
deterministic projection engine. Never compute a projection, corpus value, or
depletion age yourself -- always call run_projection (optionally with
hypothetical "assumptions" and a "horizon") for any numeric answer about the
plan. Use get_portfolio/get_buckets/get_expenses to look up current data
before reasoning about it.

If asked to change saved data (update an assumption, add an expense), call
propose_update_assumption or propose_add_expense instead of just answering --
these do NOT write anything themselves, they stage the change and return its
projected before/after impact (depletion age, corpus at end age). Always
state that clearly in your reply: tell the user what you proposed, show the
before/after impact, and say the change needs their approval in the chat UI
before it takes effect. Never say or imply that you already made the change.
If a proposal is rejected by the guardrails (e.g. an inflation rate or
expense amount outside the allowed range), relay the error and explain why,
rather than retrying with the same value.`;

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
  /** Which provider id (llm/registry.ts key) actually served this run --
   *  dynamic now that it can change per-request via the DB override, so
   *  callers must read this instead of assuming a static config value. */
  provider: string;
  /** pending_actions ids created by propose_* tool calls during this run.
   *  agent_runs doesn't exist yet while this loop is running (it's written
   *  by the caller once runAgent returns), so the caller links these to
   *  its new agent_runs row after the fact -- see routes/api.ts. */
  proposedActionIds: number[];
};

/**
 * Connects to the MCP server as a client. This agent doesn't import
 * tools.ts/data.ts/projection.ts directly -- it only knows how to talk to
 * an LlmProvider and to an MCP server. Which tools exist, what they do, and
 * which ones are read-only are all decided server-side.
 */
async function connectMcpClient(): Promise<Client> {
  const client = new Client({ name: "pwm-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${MCP_AUTH_TOKEN}` },
    },
  });
  await client.connect(transport);
  return client;
}

export async function runAgent(
  userMessage: string,
  history: ChatTurn[],
  onEvent: (event: AgentEvent) => void
): Promise<AgentResult> {
  const provider = await getActiveProvider();
  const maxTokens = provider.defaultMaxTokens;
  const mcpClient = await connectMcpClient();

  try {
    const { tools: mcpTools } = await mcpClient.listTools();
    const tools = mcpTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));

    const messages: ConversationMessage[] = [
      ...history.map((h): ConversationMessage => ({ role: h.role, content: h.content })),
      { role: "user", content: userMessage },
    ];

    let inputTokens = 0;
    let outputTokens = 0;
    const toolCalls: ToolCallLog[] = [];
    const proposedActionIds: number[] = [];

    for (let iteration = 0; iteration < AGENT_MAX_ITERATIONS; iteration++) {
      const request: CompletionRequest = {
        system: SYSTEM_PROMPT,
        tools,
        messages,
        maxTokens,
      };

      const result = await provider.streamComplete(request, (textDelta) => {
        onEvent({ type: "delta", text: textDelta });
      });

      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      messages.push({ role: "assistant", content: result.content });

      const toolUseBlocks = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        const reply = result.content
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (!reply.trim()) {
          // Model stopped without producing any visible text (commonly: it
          // used its whole max_tokens budget on thinking). Surface this as a
          // real error instead of silently returning nothing -- a
          // "successful" empty reply is worse than an explicit failure.
          throw new Error(
            `Model returned no text (stop_reason: ${result.stopReason ?? "unknown"}). ` +
              `This usually means it ran out of its token budget while thinking -- raise ${provider.id}'s ` +
              "entry in llm/anthropic/models.ts, or try a simpler question."
          );
        }
        return {
          reply,
          inputTokens,
          outputTokens,
          toolCalls,
          provider: provider.id,
          proposedActionIds,
        };
      }

      const toolResultBlocks: ContentBlock[] = [];

      for (const block of toolUseBlocks) {
        onEvent({ type: "tool_call", name: block.name, input: block.input });

        let resultText: string;
        let isError = false;
        try {
          // Input validation happens server-side in mcp-server.ts -- this
          // agent just forwards the raw arguments.
          const callResult = await mcpClient.callTool({
            name: block.name,
            arguments: block.input as Record<string, unknown>,
          });
          const textBlock = (callResult.content as Array<{ type: string; text?: string }>).find(
            (c) => c.type === "text"
          );
          resultText = textBlock?.text ?? JSON.stringify(callResult.content);
          isError = Boolean(callResult.isError);
        } catch (err) {
          isError = true;
          resultText = JSON.stringify({
            error: err instanceof Error ? err.message : "Tool call failed",
          });
        }

        let output: unknown;
        try {
          output = JSON.parse(resultText);
        } catch {
          output = resultText;
        }

        onEvent({ type: "tool_result", name: block.name, output });
        toolCalls.push({ name: block.name, input: block.input, output });

        const pendingActionId = (output as { pending_action_id?: unknown } | null)
          ?.pending_action_id;
        if (typeof pendingActionId === "number") {
          proposedActionIds.push(pendingActionId);
        }
        toolResultBlocks.push({
          type: "tool_result",
          toolUseId: block.id,
          content: resultText,
          isError,
        });
      }
      messages.push({ role: "user", content: toolResultBlocks });
    }

    throw new Error(
      `Agent exceeded ${AGENT_MAX_ITERATIONS} tool-call iterations without a final answer`
    );
  } finally {
    await mcpClient.close();
  }
}
