"use client";

import { useEffect, useRef, useState } from "react";
import {
  approveAction,
  fetchPendingActions,
  fetchSecondOpinion,
  rejectAction,
  streamChatMessage,
  type ChatMessage,
  type PendingAction,
} from "@/lib/api";

const PROPOSE_TOOL_NAMES = ["propose_update_assumption", "propose_add_expense"];
// A second opinion only makes sense on a turn that actually touched the
// plan's numbers or proposed a change -- a pure Q&A turn ("what's my
// inflation assumption?") has nothing for the critic to check or improve on.
const SECOND_OPINION_ELIGIBLE_TOOLS = ["run_projection", ...PROPOSE_TOOL_NAMES];

type RunMeta = { runId: number; eligible: boolean };
type CritiqueState =
  | { status: "loading" }
  | { status: "done"; reply: string }
  | { status: "error"; message: string };

function describeProposedInput(toolName: string, input: unknown): string {
  const i = input as Record<string, unknown>;
  if (toolName === "propose_add_expense") {
    return `Add a one-off expense of ₹${i.amount_lakhs}L at age ${i.age}`;
  }
  if (toolName === "propose_update_assumption") {
    if (i.kind === "settings") {
      return `Set ${i.field} to ${i.value}`;
    }
    return `Set ${i.bucket_name}'s ${i.field} to ${i.value}`;
  }
  return toolName;
}

function ProposalCard({
  action,
  busy,
  onApprove,
  onReject,
}: {
  action: PendingAction;
  busy: boolean;
  onApprove: (id: number) => void;
  onReject: (id: number) => void;
}) {
  const fmtAge = (age: number | null) => (age === null ? "never depletes" : `depletes at ${age}`);
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
      <p className="font-medium text-amber-900 dark:text-amber-100">
        {describeProposedInput(action.tool_name, action.proposed_input)}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-amber-800 dark:text-amber-200">
        <div>
          <p className="font-semibold">Before</p>
          <p>{fmtAge(action.before_summary.depletion_age)}</p>
          <p>Corpus at end age: ₹{action.before_summary.end_corpus_lakhs}L</p>
        </div>
        <div>
          <p className="font-semibold">After</p>
          <p>{fmtAge(action.after_summary.depletion_age)}</p>
          <p>Corpus at end age: ₹{action.after_summary.end_corpus_lakhs}L</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
        Expires at {new Date(action.expires_at).toLocaleTimeString()}
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onApprove(action.id)}
          className="rounded-md bg-amber-900 px-3 py-1 text-xs font-medium text-white hover:bg-amber-800 disabled:opacity-50 dark:bg-amber-100 dark:text-amber-900"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onReject(action.id)}
          className="rounded-md border border-amber-300 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/40"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

// Visually distinct from both the assistant's own bubble and the amber
// ProposalCard -- this is a second, independent agent's opinion, not the
// primary agent talking, and not something awaiting approval.
function CritiqueCard({ state }: { state: CritiqueState }) {
  if (state.status === "loading") {
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-700 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-300">
        Getting a second opinion…
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
        {state.message}
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm dark:border-sky-900 dark:bg-sky-950/40">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-300">
        Second opinion
      </p>
      <p className="whitespace-pre-wrap text-sky-900 dark:text-sky-100">{state.reply}</p>
    </div>
  );
}

export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [busyActionId, setBusyActionId] = useState<number | null>(null);
  // Keyed by index into `messages` (always an assistant message's index) --
  // runId comes from the chat stream's `done` event, eligible is set once
  // we know whether that turn touched run_projection/propose_*.
  const [runMeta, setRunMeta] = useState<Record<number, RunMeta>>({});
  const [critiques, setCritiques] = useState<Record<number, CritiqueState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  function refreshPendingActions() {
    fetchPendingActions("pending")
      .then(setPendingActions)
      .catch(() => {
        // Non-fatal: the chat itself still works without this list.
      });
  }

  useEffect(() => {
    refreshPendingActions();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, loading, pendingActions]);

  async function handleApprove(id: number) {
    setBusyActionId(id);
    try {
      await approveAction(id);
      setPendingActions((list) => list.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approve failed");
    } finally {
      setBusyActionId(null);
    }
  }

  async function handleReject(id: number) {
    setBusyActionId(id);
    try {
      await rejectAction(id);
      setPendingActions((list) => list.filter((a) => a.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setBusyActionId(null);
    }
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    const next = [...messages, { role: "user", content: text } as ChatMessage];
    const assistantIndex = next.length;
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setToolActivity([]);
    setLoading(true);

    let eligibleForSecondOpinion = false;

    try {
      const usage = await streamChatMessage(
        text,
        next,
        (delta) => {
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1];
            copy[copy.length - 1] = { ...last, content: last.content + delta };
            return copy;
          });
        },
        (toolEvent) => {
          setToolActivity((log) => {
            if (toolEvent.phase === "call") {
              return [...log, `Calling ${toolEvent.name}…`];
            }
            const idx = log.lastIndexOf(`Calling ${toolEvent.name}…`);
            if (idx === -1) return log;
            const copy = [...log];
            copy[idx] = `Called ${toolEvent.name}`;
            return copy;
          });
          if (toolEvent.phase === "call" && SECOND_OPINION_ELIGIBLE_TOOLS.includes(toolEvent.name)) {
            eligibleForSecondOpinion = true;
          }
          if (toolEvent.phase === "result" && PROPOSE_TOOL_NAMES.includes(toolEvent.name)) {
            refreshPendingActions();
          }
        }
      );
      setRunMeta((m) => ({
        ...m,
        [assistantIndex]: { runId: usage.runId, eligible: eligibleForSecondOpinion },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chat request failed");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }

  async function handleSecondOpinion(messageIndex: number, runId: number) {
    setCritiques((c) => ({ ...c, [messageIndex]: { status: "loading" } }));
    try {
      const run = await fetchSecondOpinion(runId);
      setCritiques((c) => ({
        ...c,
        [messageIndex]: { status: "done", reply: run.reply ?? "(no reply)" },
      }));
    } catch (e) {
      setCritiques((c) => ({
        ...c,
        [messageIndex]: {
          status: "error",
          message: e instanceof Error ? e.message : "Second opinion failed",
        },
      }));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div className="mt-10 rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          Ask about your plan
        </h2>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          e.g. &quot;What if inflation is 7% and I retire at 55?&quot;
        </p>
      </div>

      <div
        ref={scrollRef}
        className="max-h-80 space-y-3 overflow-y-auto px-5 py-4"
      >
        {messages.length === 0 && (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            No messages yet.
          </p>
        )}
        {messages.map((m, i) => {
          const meta = runMeta[i];
          const critique = critiques[i];
          return (
            <div key={i} className="space-y-1.5">
              <div className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                <div
                  className={`max-w-[80%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
                  }`}
                >
                  {m.content || (loading && i === messages.length - 1 ? "…" : "")}
                </div>
              </div>
              {meta?.eligible && !critique && (
                <div className="flex justify-start">
                  <button
                    type="button"
                    onClick={() => handleSecondOpinion(i, meta.runId)}
                    className="rounded-md border border-sky-300 px-2.5 py-1 text-xs font-medium text-sky-700 hover:bg-sky-50 dark:border-sky-700 dark:text-sky-300 dark:hover:bg-sky-950/40"
                  >
                    Get a second opinion
                  </button>
                </div>
              )}
              {critique && (
                <div className="flex justify-start">
                  <div className="max-w-[80%] w-full">
                    <CritiqueCard state={critique} />
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {toolActivity.length > 0 && (
          <div className="space-y-0.5 text-xs text-zinc-400 dark:text-zinc-500">
            {toolActivity.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>
        )}
        {pendingActions.map((action) => (
          <ProposalCard
            key={action.id}
            action={action}
            busy={busyActionId === action.id}
            onApprove={handleApprove}
            onReject={handleReject}
          />
        ))}
      </div>

      {error && (
        <p className="border-t border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {error}
        </p>
      )}

      <div className="flex gap-2 border-t border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question about your plan…"
          disabled={loading}
          className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={loading || !input.trim()}
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Send
        </button>
      </div>
    </div>
  );
}
