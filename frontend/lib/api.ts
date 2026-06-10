/** Browser calls the host-published API port; Next.js SSR in Docker must use the service name. */
function apiBase(): string {
  const strip = (u: string) => u.replace(/\/$/, "");
  if (typeof window === "undefined") {
    const internal = process.env.API_INTERNAL_URL;
    if (internal) return strip(internal);
  }
  return strip(
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
  );
}

export type Settings = {
  inflation_pct: string;
  start_age: number;
  end_age: number;
};

export type InvestmentBucket = {
  name: string;
  corpus_lakhs: string;
  return_pct: string;
};

export type Flow = {
  age: number;
  inflow_lakhs: string;
  outflow_lakhs: string;
};

export type LumpSum = {
  age: number;
  amount_lakhs: string;
};

export type SwpPlan = {
  start_age: number;
  end_age: number;
  monthly_amount_lakhs: string;
};

export type ProjectionPoint = {
  age: number;
  startCorpusLakhs: number;
  netFlowLakhs: number;
  endCorpusLakhs: number;
};

export type FullState = {
  settings: Settings;
  investment_buckets: InvestmentBucket[];
  flows: Flow[];
  lump_sum_outgoes: LumpSum[];
  lump_sum_inflows: LumpSum[];
  swp_plans: SwpPlan[];
  projection: ProjectionPoint[];
};

export function totalCorpusLakhs(buckets: InvestmentBucket[]): number {
  return buckets.reduce((sum, b) => sum + Number(b.corpus_lakhs), 0);
}

export function weightedReturnPct(buckets: InvestmentBucket[]): number {
  const total = totalCorpusLakhs(buckets);
  if (total <= 0) return 0;
  return (
    buckets.reduce(
      (sum, b) => sum + Number(b.corpus_lakhs) * Number(b.return_pct),
      0
    ) / total
  );
}

/** First age (year-end) where corpus is zero or negative; null if it never runs out. */
export function corpusDepletionAge(
  projection: ProjectionPoint[]
): number | null {
  for (const p of projection) {
    if (p.endCorpusLakhs <= 0) return p.age;
  }
  return null;
}

export async function fetchFullState(): Promise<FullState> {
  const res = await fetch(`${apiBase()}/api/settings`, { cache: "no-store" });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  return res.json();
}

export type SavePayload = {
  investment_buckets: {
    name: string;
    corpus_lakhs: number;
    return_pct: number;
  }[];
  inflation_pct: number;
  start_age: number;
  end_age: number;
  flows: { age: number; inflow_lakhs: number; outflow_lakhs: number }[];
  lump_sum_outgoes: { age: number; amount_lakhs: number }[];
  lump_sum_inflows: { age: number; amount_lakhs: number }[];
  swp_plans: {
    start_age: number;
    end_age: number;
    monthly_amount_lakhs: number;
  }[];
};

export async function saveSettings(body: SavePayload): Promise<FullState> {
  const res = await fetch(`${apiBase()}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      typeof err?.error === "string" ? err.error : `Save failed (${res.status})`
    );
  }
  return res.json();
}
