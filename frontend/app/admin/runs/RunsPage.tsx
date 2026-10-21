"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  fetchAgentRunStats,
  fetchAgentRuns,
  type AgentRunStats,
  type AgentRunSummary,
} from "@/lib/api";

const PAGE_SIZE = 20;

function fmtMs(ms: number | null): string {
  return ms === null ? "—" : `${ms.toLocaleString()}ms`;
}

function fmtCost(cost: string | number | null): string {
  if (cost === null) return "n/a";
  return `$${Number(cost).toFixed(4)}`;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
    </div>
  );
}

export function RunsPage() {
  const [stats, setStats] = useState<AgentRunStats | null>(null);
  const [runs, setRuns] = useState<AgentRunSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [stopReason, setStopReason] = useState("");
  const [model, setModel] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAgentRunStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetchAgentRuns({
      status: status || undefined,
      stopReason: stopReason || undefined,
      model: model || undefined,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((d) => {
        setRuns(d.runs);
        setTotal(d.total);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load runs"))
      .finally(() => setLoading(false));
  }, [status, stopReason, model, fromDate, toDate, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Runs (14d)" value={String(stats.runsPerDay.reduce((s, d) => s + d.count, 0))} />
          <StatCard label="Failure rate" value={`${(stats.failureRate * 100).toFixed(0)}%`} />
          <StatCard label="Avg cost/run" value={fmtCost(stats.avgCostUsd)} />
          <StatCard label="p95 latency" value={fmtMs(stats.p95LatencyMs)} />
        </div>
      )}

      {stats && stats.topTools.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-950">
          <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Most-called tools</p>
          <p className="mt-1 text-zinc-700 dark:text-zinc-300">
            {stats.topTools.map((t) => `${t.name} (${t.count})`).join(", ")}
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <label className="text-xs text-zinc-600 dark:text-zinc-400">
          Status
          <select
            value={status}
            onChange={(e) => {
              setPage(1);
              setStatus(e.target.value);
            }}
            className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">All</option>
            <option value="ok">ok</option>
            <option value="error">error</option>
          </select>
        </label>
        <label className="text-xs text-zinc-600 dark:text-zinc-400">
          Stop reason
          <select
            value={stopReason}
            onChange={(e) => {
              setPage(1);
              setStopReason(e.target.value);
            }}
            className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">All</option>
            <option value="answered">answered</option>
            <option value="awaiting_approval">awaiting_approval</option>
            <option value="iteration_cap">iteration_cap</option>
            <option value="error">error</option>
          </select>
        </label>
        <label className="text-xs text-zinc-600 dark:text-zinc-400">
          Model
          <input
            value={model}
            onChange={(e) => {
              setPage(1);
              setModel(e.target.value);
            }}
            placeholder="e.g. claude-haiku"
            className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="text-xs text-zinc-600 dark:text-zinc-400">
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => {
              setPage(1);
              setFromDate(e.target.value);
            }}
            className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
        <label className="text-xs text-zinc-600 dark:text-zinc-400">
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => {
              setPage(1);
              setToDate(e.target.value);
            }}
            className="mt-1 block rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </label>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">When</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Model</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Message</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Status</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Stop reason</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Latency</th>
              <th className="px-3 py-2 text-left font-medium text-zinc-500 dark:text-zinc-400">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-900 dark:bg-zinc-950">
            {!loading && runs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-zinc-400 dark:text-zinc-500">
                  No runs match these filters.
                </td>
              </tr>
            )}
            {runs.map((r) => (
              <tr key={r.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{r.model}</td>
                <td className="max-w-xs truncate px-3 py-2 text-zinc-700 dark:text-zinc-300">
                  <Link href={`/admin/runs/${r.id}`} className="underline hover:text-zinc-900 dark:hover:text-zinc-100">
                    {r.user_message}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      r.status === "error"
                        ? "text-red-600 dark:text-red-400"
                        : "text-emerald-600 dark:text-emerald-400"
                    }
                  >
                    {r.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{r.stop_reason ?? "—"}</td>
                <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{fmtMs(r.total_latency_ms)}</td>
                <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{fmtCost(r.cost_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-zinc-600 dark:text-zinc-400">
        <span>
          {total} run{total === 1 ? "" : "s"} total
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium disabled:opacity-50 dark:border-zinc-600"
          >
            Previous
          </button>
          <span className="px-2 py-1 text-xs">
            Page {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs font-medium disabled:opacity-50 dark:border-zinc-600"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
