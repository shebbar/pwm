import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AGENT_MAX_ITERATIONS, LLM_MAX_RETRIES, MCP_PROPOSE_TOKEN, MCP_SERVER_URL } from "./config.js";
import { getActiveProvider } from "./llm/registry.js";
import {
  RetryableLlmError,
  type CompletionRequest,
  type CompletionResult,
  type ContentBlock,
  type ConversationMessage,
} from "./llm/types.js";

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
rather than retrying with the same value.

When the user gives an explicit numeric value (a rate, an amount, an age),
use that exact number in the proposal -- never substitute your own
adjustment (e.g. a tax or inflation correction) unless they specifically
asked you to compute one. This applies to every proposal in a turn: if you
are proposing the same change across multiple buckets, every one of them
must carry the exact value the user gave, not a value you derived.`;

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AgentEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call"; name: string; input: unknown }
  | { type: "tool_result"; name: string; output: unknown };

// sequence is a single incrementing counter shared across llm_call and
// tool_call entries, assigned in true chronological order -- the two kinds
// are collected into separate arrays as the loop runs, but sequence lets
// anything downstream (the agent_runs row, the admin runs page) merge them
// back into one real timeline.
export type ToolCallLog = {
  name: string;
  input: unknown;
  output: unknown;
  latencyMs: number;
  sequence: number;
};

export type LlmCallLog = {
  sequence: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** How many RetryableLlmError retries this specific call needed (0 = succeeded first try). */
  retries: number;
};

export type AgentStopReason = "answered" | "iteration_cap" | "awaiting_approval";

export type AgentResult = {
  reply: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: ToolCallLog[];
  llmCalls: LlmCallLog[];
  totalLatencyMs: number;
  iterationCount: number;
  /** Total retries across every LLM call in this run -- sum of
   *  llmCalls[].retries, exposed directly so callers don't have to. */
  retryCount: number;
  /** "awaiting_approval" means the run answered normally AND staged at
   *  least one proposal (see proposedActionIds) -- there's no actual
   *  pause-point in this architecture (propose_* tools return immediately,
   *  approval happens out-of-band via /api/actions), so this is derived,
   *  not a distinct code path. "error" is set by the caller's catch block,
   *  not here -- see routes/api.ts. */
  stopReason: AgentStopReason;
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

export type PartialAgentTrace = {
  toolCalls: ToolCallLog[];
  llmCalls: LlmCallLog[];
  totalLatencyMs: number;
  iterationCount: number;
  /** Known at every throw site (AgentRunError is only thrown after
   *  getActiveProvider() already succeeded) -- carried along so the
   *  caller's error-path agent_runs row names the real model instead of
   *  falling back to a placeholder. */
  provider: string;
};

/** Thrown instead of a plain Error whenever the loop has already made
 *  some progress (completed tool calls, LLM calls) before failing --
 *  carries that partial trace so routes/api.ts can log a real agent_runs
 *  row on failure instead of an empty one. A failure before any of that
 *  exists yet (e.g. the MCP connection itself) just throws a plain Error,
 *  same as before -- there's nothing to attach. */
export class AgentRunError extends Error {
  constructor(message: string, public readonly partial: PartialAgentTrace) {
    super(message);
    this.name = "AgentRunError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries only RetryableLlmError (rate limit, overload, connection
 *  failure -- classified by the provider, see llm/anthropic/provider.ts),
 *  with exponential backoff. Anything else fails immediately -- retrying
 *  a bad request or an auth error would just fail the same way again. */
async function streamCompleteWithRetry(
  provider: { streamComplete(request: CompletionRequest, onTextDelta: (delta: string) => void): Promise<CompletionResult> },
  request: CompletionRequest,
  onTextDelta: (delta: string) => void
): Promise<{ result: CompletionResult; retries: number }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const result = await provider.streamComplete(request, onTextDelta);
      return { result, retries: attempt };
    } catch (err) {
      lastErr = err;
      if (!(err instanceof RetryableLlmError) || attempt === LLM_MAX_RETRIES) {
        throw err;
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  // Unreachable (the loop above always either returns or throws), but
  // keeps TypeScript happy without an unsound non-null assertion.
  throw lastErr;
}

/**
 * Connects to the MCP server as a client. This agent doesn't import
 * tools.ts/data.ts/projection.ts directly -- it only knows how to talk to
 * an LlmProvider and to an MCP server. Which tools exist, what they do, and
 * which ones are read-only are all decided server-side. Uses the
 * read+propose-scoped token since this in-app agent (unlike an external
 * client such as Claude Desktop) is meant to be able to stage proposals.
 */
async function connectMcpClient(): Promise<Client> {
  const client = new Client({ name: "pwm-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${MCP_PROPOSE_TOKEN}` },
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
  const runStart = Date.now();

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
    let sequence = 0;
    const toolCalls: ToolCallLog[] = [];
    const llmCalls: LlmCallLog[] = [];
    const proposedActionIds: number[] = [];
    // Tracks the latest non-empty reply text seen across iterations, even
    // from a turn that also made tool calls -- today that text is simply
    // discarded, but it's the best material for a graceful partial answer
    // if the loop hits AGENT_MAX_ITERATIONS without ever finishing cleanly.
    let lastReplyText = "";

    for (let iteration = 0; iteration < AGENT_MAX_ITERATIONS; iteration++) {
      const request: CompletionRequest = {
        system: SYSTEM_PROMPT,
        tools,
        messages,
        maxTokens,
      };

      let llmCallResult: { result: CompletionResult; retries: number };
      const llmCallStart = Date.now();
      try {
        llmCallResult = await streamCompleteWithRetry(provider, request, (textDelta) => {
          onEvent({ type: "delta", text: textDelta });
        });
      } catch (err) {
        // The call itself failed (non-retryable, or retries exhausted) --
        // no new llmCalls entry for it, but attach whatever the run had
        // already accomplished in earlier iterations so the caller can
        // still log a real trace instead of an empty error row.
        throw new AgentRunError(err instanceof Error ? err.message : String(err), {
          toolCalls,
          llmCalls,
          totalLatencyMs: Date.now() - runStart,
          iterationCount: iteration,
          provider: provider.id,
        });
      }
      const result = llmCallResult.result;
      llmCalls.push({
        sequence: sequence++,
        latencyMs: Date.now() - llmCallStart,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        stopReason: result.stopReason,
        retries: llmCallResult.retries,
      });

      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      messages.push({ role: "assistant", content: result.content });

      const replyText = result.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (replyText.trim()) lastReplyText = replyText;

      const toolUseBlocks = result.content.filter(
        (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use"
      );

      if (toolUseBlocks.length === 0) {
        if (!replyText.trim()) {
          // Model stopped without producing any visible text (commonly: it
          // used its whole max_tokens budget on thinking). Surface this as a
          // real error instead of silently returning nothing -- a
          // "successful" empty reply is worse than an explicit failure.
          throw new AgentRunError(
            `Model returned no text (stop_reason: ${result.stopReason ?? "unknown"}). ` +
              `This usually means it ran out of its token budget while thinking -- raise ${provider.id}'s ` +
              "entry in llm/anthropic/models.ts, or try a simpler question.",
            {
              toolCalls,
              llmCalls,
              totalLatencyMs: Date.now() - runStart,
              iterationCount: iteration + 1,
              provider: provider.id,
            }
          );
        }
        return {
          reply: replyText,
          inputTokens,
          outputTokens,
          toolCalls,
          llmCalls,
          totalLatencyMs: Date.now() - runStart,
          iterationCount: iteration + 1,
          retryCount: llmCalls.reduce((sum, c) => sum + c.retries, 0),
          stopReason: proposedActionIds.length > 0 ? "awaiting_approval" : "answered",
          provider: provider.id,
          proposedActionIds,
        };
      }

      const toolResultBlocks: ContentBlock[] = [];

      for (const block of toolUseBlocks) {
        onEvent({ type: "tool_call", name: block.name, input: block.input });

        const toolCallStart = Date.now();
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
        toolCalls.push({
          name: block.name,
          input: block.input,
          output,
          latencyMs: Date.now() - toolCallStart,
          sequence: sequence++,
        });

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

    // Graceful stop instead of a throw: the loop still has whatever the
    // last iteration said (even though it also made tool calls that turn),
    // which is almost always more useful to the user than nothing. Only
    // falls back to a generic message if that iteration was pure tool-use
    // with no accompanying text at all.
    const partialReply = lastReplyText.trim()
      ? `${lastReplyText.trim()}\n\n(I wasn't able to fully finish within my step limit, so this may be incomplete.)`
      : `I wasn't able to reach a final answer within ${AGENT_MAX_ITERATIONS} steps. ` +
        `Last actions taken: ${toolCalls.slice(-3).map((t) => t.name).join(", ") || "none"}.`;

    return {
      reply: partialReply,
      inputTokens,
      outputTokens,
      toolCalls,
      llmCalls,
      totalLatencyMs: Date.now() - runStart,
      iterationCount: AGENT_MAX_ITERATIONS,
      retryCount: llmCalls.reduce((sum, c) => sum + c.retries, 0),
      stopReason: "iteration_cap",
      provider: provider.id,
      proposedActionIds,
    };
  } finally {
    await mcpClient.close();
  }
}
