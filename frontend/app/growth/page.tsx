import Link from "next/link";
import { fetchFullState } from "@/lib/api";
import { GrowthChart } from "./GrowthChart";

export default async function GrowthPage() {
  let state = null as Awaited<ReturnType<typeof fetchFullState>> | null;
  let error: string | null = null;
  try {
    state = await fetchFullState();
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not load data";
  }

  if (error || !state) {
    return (
      <main className="mx-auto max-w-5xl px-4 py-10">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
          Investment growth
        </h1>
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>
        <Link href="/" className="mt-4 inline-block text-sm text-zinc-600 underline">
          Back to dashboard
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Investment growth
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        End-of-year corpus from age {state.settings.start_age} through{" "}
        {state.settings.end_age}, in Rs Lakhs (after flows and real return).
      </p>
      <div className="mt-8 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <GrowthChart projection={state.projection} />
      </div>
    </main>
  );
}
