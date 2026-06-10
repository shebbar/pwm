import Link from "next/link";
import {
  corpusDepletionAge,
  fetchFullState,
  totalCorpusLakhs,
  weightedReturnPct,
} from "@/lib/api";

function formatLakhs(n: number): string {
  return new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(n);
}

export default async function DashboardPage() {
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
          Dashboard
        </h1>
        <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          {error ?? "Unknown error"}. Ensure the API is running and{" "}
          <code className="rounded bg-amber-100 px-1 dark:bg-amber-900/60">
            NEXT_PUBLIC_API_URL
          </code>{" "}
          points to it.
        </p>
      </main>
    );
  }

  const { settings, investment_buckets, projection } = state;
  const corpus = totalCorpusLakhs(investment_buckets);
  const ret = weightedReturnPct(investment_buckets);
  const inf = Number(settings.inflation_pct);
  const last = projection[projection.length - 1];
  const finalCorpus = last?.endCorpusLakhs ?? 0;
  const depletionAge = corpusDepletionAge(projection);

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50">
        Dashboard
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        Net worth model from age {settings.start_age} to {settings.end_age}.
        Amounts in Rs Lakhs. Each investment bucket compounds at its own real
        return{" "}
        <span className="font-medium text-zinc-800 dark:text-zinc-200">
          (1 + bucket return) ÷ (1 + inflation) − 1
        </span>{" "}
        after each year&apos;s flows (allocated pro-rata across buckets).
      </p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Current corpus
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            ₹ {formatLakhs(corpus)} L
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Weighted avg return
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {ret.toFixed(2)}%{" "}
            <span className="text-base font-normal text-zinc-500">nominal</span>
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Inflation
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">
            {inf}%
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Corpus at age {settings.end_age}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
            ₹ {formatLakhs(finalCorpus)} L
          </p>
        </div>
        <div className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Corpus runs out at age
          </p>
          {depletionAge !== null ? (
            <p className="mt-1 text-2xl font-semibold tabular-nums text-red-700 dark:text-red-400">
              {depletionAge}
            </p>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                —
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Still positive through age {settings.end_age}
              </p>
            </>
          )}
        </div>
      </div>

      <div className="mt-10 flex flex-wrap gap-3">
        <Link
          href="/admin"
          className="inline-flex items-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          Edit assumptions &amp; flows
        </Link>
        <Link
          href="/growth"
          className="inline-flex items-center rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
        >
          View growth chart
        </Link>
      </div>
    </main>
  );
}
