import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { ModelReport } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// backend/src/evals/report.ts -> backend/evals/results/ -- a sibling of
// src/, not under it, since these are generated run artifacts (gitignored
// timestamped files), not source code.
const RESULTS_DIR = join(__dirname, "..", "..", "evals", "results");

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtUsd(n: number | null): string {
  return n === null ? "n/a" : `$${n.toFixed(4)}`;
}

export function toMarkdown(reports: ModelReport[]): string {
  const lines: string[] = [];
  lines.push("# Eval results", "");
  lines.push("| Model | Pass rate | Avg input tok | Avg output tok | Avg cost/question | p50 latency | p95 latency |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of reports) {
    lines.push(
      `| ${r.catalogId} | ${fmtPct(r.overallPassRate)} | ${r.avgInputTokens.toFixed(0)} | ${r.avgOutputTokens.toFixed(0)} | ${fmtUsd(r.avgCostUsd)} | ${r.p50LatencyMs.toFixed(0)}ms | ${r.p95LatencyMs.toFixed(0)}ms |`
    );
  }
  lines.push("");

  for (const r of reports) {
    lines.push(`## ${r.catalogId} — by category`, "");
    lines.push("| Category | Pass rate |");
    lines.push("|---|---|");
    for (const [cat, rate] of Object.entries(r.categoryPassRates)) {
      lines.push(`| ${cat} | ${fmtPct(rate as number)} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function writeResults(reports: ModelReport[]): {
  jsonPath: string;
  mdPath: string;
  markdown: string;
} {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(RESULTS_DIR, `${timestamp}.json`);
  const mdPath = join(RESULTS_DIR, `${timestamp}.md`);
  const markdown = toMarkdown(reports);
  writeFileSync(jsonPath, JSON.stringify(reports, null, 2));
  writeFileSync(mdPath, markdown);
  return { jsonPath, mdPath, markdown };
}
