"use client";

import { useEffect, useRef, useState } from "react";
import {
  approveAction,
  fetchPendingActions,
  rejectAction,
  streamChatMessage,
  type ChatMessage,
  type PendingAction,
} from "@/lib/api";

const PROPOSE_TOOL_NAMES = ["propose_update_assumption", "propose_add_expense"];

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

export default function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolActivity, setToolActivity] = useState<string[]>([]);
  const [pendingActions, setPendingActions] = useState<PendingAction[]>([]);
  const [busyActionId, setBusyActionId] = useState<number | null>(null);
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
    setMessages([...next, { role: "assistant", content: "" }]);
    setInput("");
    setError(null);
    setToolActivity([]);
    setLoading(true);

    try {
      await streamChatMessage(
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
          if (toolEvent.phase === "result" && PROPOSE_TOOL_NAMES.includes(toolEvent.name)) {
            refreshPendingActions();
          }
        }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Chat request failed");
      setMessages((m) => m.slice(0, -1));
    } finally {
      setLoading(false);
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
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
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
        ))}
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
