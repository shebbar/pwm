export type SettingsRow = {
  inflation_pct: string;
  start_age: number;
  end_age: number;
};

export type InvestmentBucketRow = {
  name: string;
  corpus_lakhs: string;
  return_pct: string;
  asset_class: "equity" | "debt" | "cash";
};

export type FlowRow = {
  age: number;
  inflow_lakhs: string;
  outflow_lakhs: string;
};

export type LumpSumRow = {
  age: number;
  amount_lakhs: string;
};

export type SwpPlanRow = {
  start_age: number;
  end_age: number;
  monthly_amount_lakhs: string;
};

export type YearPoint = {
  age: number;
  startCorpusLakhs: number;
  netFlowLakhs: number;
  endCorpusLakhs: number;
};

export function totalCorpusLakhs(buckets: InvestmentBucketRow[]): number {
  return buckets.reduce((sum, b) => sum + Number(b.corpus_lakhs), 0);
}

export function weightedReturnPct(buckets: InvestmentBucketRow[]): number {
  const total = totalCorpusLakhs(buckets);
  if (total <= 0) return 0;
  return (
    buckets.reduce(
      (sum, b) => sum + Number(b.corpus_lakhs) * Number(b.return_pct),
      0
    ) / total
  );
}

/** Real growth factor after flows: Fisher-style (1+r)/(1+i) - 1, then compound. */
function realGrowthFactor(portfolioReturnPct: number, inflationPct: number): number {
  const r = portfolioReturnPct / 100;
  const i = inflationPct / 100;
  return (1 + r) / (1 + i);
}

function sumLumpsByAge(
  rows: LumpSumRow[],
  startAge: number,
  endAge: number
): Map<number, number> {
  const map = new Map<number, number>();
  for (const l of rows) {
    if (l.age < startAge || l.age > endAge) continue;
    const amt = Number(l.amount_lakhs);
    map.set(l.age, (map.get(l.age) ?? 0) + amt);
  }
  return map;
}

/** Annual SWP outflow (lakhs) per age from monthly plans over inclusive age ranges. */
function swpAnnualByAge(
  plans: SwpPlanRow[],
  startAge: number,
  endAge: number
): Map<number, number> {
  const map = new Map<number, number>();
  for (const plan of plans) {
    const monthly = Number(plan.monthly_amount_lakhs);
    if (!Number.isFinite(monthly) || monthly <= 0) continue;
    const from = Math.max(startAge, plan.start_age);
    const to = Math.min(endAge, plan.end_age);
    if (from > to) continue;
    const annual = monthly * 12;
    for (let age = from; age <= to; age++) {
      map.set(age, (map.get(age) ?? 0) + annual);
    }
  }
  return map;
}

/** Apply net cash flow across buckets in proportion to each bucket's balance. */
function applyNetFlowProRata(balances: number[], netFlow: number): void {
  if (netFlow === 0 || balances.length === 0) return;
  const total = balances.reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (let i = 0; i < balances.length; i++) {
      balances[i] += netFlow * (balances[i] / total);
    }
    return;
  }
  const each = netFlow / balances.length;
  for (let i = 0; i < balances.length; i++) {
    balances[i] += each;
  }
}

export function buildProjection(
  settings: SettingsRow,
  buckets: InvestmentBucketRow[],
  flows: FlowRow[],
  lumpSumOutgoes: LumpSumRow[] = [],
  lumpSumInflows: LumpSumRow[] = [],
  swpPlans: SwpPlanRow[] = []
): YearPoint[] {
  const startAge = settings.start_age;
  const endAge = settings.end_age;
  const inflationPct = Number(settings.inflation_pct);

  const flowMap = new Map<number, { in: number; out: number }>();
  for (const f of flows) {
    flowMap.set(f.age, {
      in: Number(f.inflow_lakhs),
      out: Number(f.outflow_lakhs),
    });
  }
  const lumpOutMap = sumLumpsByAge(lumpSumOutgoes, startAge, endAge);
  const lumpInMap = sumLumpsByAge(lumpSumInflows, startAge, endAge);
  const swpMap = swpAnnualByAge(swpPlans, startAge, endAge);

  const bucketReturns = buckets.map((b) => Number(b.return_pct));
  let balances = buckets.map((b) => Number(b.corpus_lakhs));

  if (balances.length === 0) {
    balances = [0];
    bucketReturns.push(0);
  }

  const points: YearPoint[] = [];

  for (let age = startAge; age <= endAge; age++) {
    const startCorpus = balances.reduce((a, b) => a + b, 0);
    const fl = flowMap.get(age) ?? { in: 0, out: 0 };
    const lumpOut = lumpOutMap.get(age) ?? 0;
    const lumpIn = lumpInMap.get(age) ?? 0;
    const swpOut = swpMap.get(age) ?? 0;
    const netFlow = fl.in - fl.out + lumpIn - lumpOut - swpOut;

    applyNetFlowProRata(balances, netFlow);

    for (let i = 0; i < balances.length; i++) {
      const growth = realGrowthFactor(bucketReturns[i], inflationPct);
      balances[i] *= growth;
    }

    const endCorpus = balances.reduce((a, b) => a + b, 0);

    points.push({
      age,
      startCorpusLakhs: round4(startCorpus),
      netFlowLakhs: round4(netFlow),
      endCorpusLakhs: round4(endCorpus),
    });
  }

  return points;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** First age (year-end) where corpus is zero or negative; null if it never runs out. */
export function corpusDepletionAge(points: YearPoint[]): number | null {
  for (const p of points) {
    if (p.endCorpusLakhs <= 0) return p.age;
  }
  return null;
}
