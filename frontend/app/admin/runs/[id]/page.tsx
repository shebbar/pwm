import Link from "next/link";
import { fetchAgentRun, type LlmCallEntry, type ToolCallEntry } from "@/lib/api";

type Step =
  | { kind: "llm_call"; sequence: number; data: LlmCallEntry }
  | { kind: "tool_call"; sequence: number; data: ToolCallEntry };

function mergeSteps(llmCalls: LlmCallEntry[], toolCalls: ToolCallEntry[]): Step[] {
  const steps: Step[] = [
    ...llmCalls.map((data): Step => ({ kind: "llm_call", sequence: data.sequence, data })),
    ...toolCalls.map((data): Step => ({ kind: "tool_call", sequence: data.sequence, data })),
  ];
  return steps.sort((a, b) => a.sequence - b.sequence);
}

export default async function AgentRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  let run = null as Awaited<ReturnType<typeof fetchAgentRun>> | null;
  let error: string | null = null;
  try {
    run = await fetchAgentRun(Number(id));
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not load this run";
  }

  if (error || !run) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <Link href="/admin/runs" className="text-sm text-zinc-600 underline dark:text-zinc-400">
          ← Back to runs
        </Link>
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
      </main>
    );
  }

  const steps = mergeSteps(run.llm_calls, run.tool_calls);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <Link href="/admin/runs" className="text-sm text-zinc-600 underline dark:text-zinc-400">
        ← Back to runs
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">Run #{run.id}</h1>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
        {new Date(run.created_at).toLocaleString()} -- {run.model}
      </p>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Status</p>
          <p
            className={`mt-1 text-lg font-semibold ${
              run.status === "error" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
            }`}
          >
            {run.status}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Stop reason</p>
          <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{run.stop_reason ?? "—"}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Total latency</p>
          <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {run.total_latency_ms?.toLocaleString() ?? "—"}ms
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Cost</p>
          <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            {run.cost_usd === null ? "n/a" : `$${Number(run.cost_usd).toFixed(4)}`}
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">User message</p>
        <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{run.user_message}</p>
      </div>

      {run.reply && (
        <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Reply</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{run.reply}</p>
        </div>
      )}

      {run.error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-xs font-medium text-red-700 dark:text-red-300">Error</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-red-800 dark:text-red-200">{run.error}</p>
        </div>
      )}

      <h2 className="mt-8 text-lg font-semibold text-zinc-900 dark:text-zinc-50">Timeline</h2>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        llm_calls and tool_calls merged by their original sequence order.
      </p>
      <ol className="mt-4 space-y-3">
        {steps.map((step, i) => (
          <li
            key={`${step.kind}-${step.sequence}-${i}`}
            className="rounded-lg border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950"
          >
            {step.kind === "llm_call" ? (
              <>
                <p className="font-medium text-zinc-900 dark:text-zinc-50">
                  LLM call -- {step.data.latencyMs.toLocaleString()}ms
                  {step.data.retries > 0 ? ` (${step.data.retries} retr${step.data.retries === 1 ? "y" : "ies"})` : ""}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {step.data.inputTokens} in / {step.data.outputTokens} out tokens -- stop_reason: {step.data.stopReason ?? "—"}
                </p>
              </>
            ) : (
              <>
                <p className="font-medium text-zinc-900 dark:text-zinc-50">
                  Tool call: {step.data.name} -- {step.data.latencyMs.toLocaleString()}ms
                </p>
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-zinc-500 dark:text-zinc-400">
                    input / output
                  </summary>
                  <pre className="mt-1 overflow-x-auto rounded bg-zinc-50 p-2 text-xs text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                    {JSON.stringify({ input: step.data.input, output: step.data.output }, null, 2)}
                  </pre>
                </details>
              </>
            )}
          </li>
        ))}
      </ol>
    </main>
  );
}
