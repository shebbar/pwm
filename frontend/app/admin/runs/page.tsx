import { RunsPage } from "./RunsPage";

export default function AgentRunsPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Agent runs
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Every chat request the agent has handled -- what it did, how long it
        took, and what it cost.
      </p>
      <div className="mt-8">
        <RunsPage />
      </div>
    </main>
  );
}
