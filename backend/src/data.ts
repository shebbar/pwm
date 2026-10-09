import { pool } from "./db.js";
import type {
  FlowRow,
  InvestmentBucketRow,
  LumpSumRow,
  SettingsRow,
  SwpPlanRow,
} from "./projection.js";

export async function loadSettings(): Promise<SettingsRow> {
  const { rows } = await pool.query<SettingsRow>(
    `SELECT inflation_pct, start_age, end_age FROM app_settings WHERE id = 1`
  );
  if (!rows[0]) throw new Error("Missing app_settings row");
  return rows[0];
}

export async function loadInvestmentBuckets(): Promise<InvestmentBucketRow[]> {
  const { rows } = await pool.query<InvestmentBucketRow>(
    `SELECT name, corpus_lakhs, return_pct, asset_class FROM investment_buckets ORDER BY id`
  );
  return rows;
}

export async function loadFlows(): Promise<FlowRow[]> {
  const { rows } = await pool.query<FlowRow>(
    `SELECT age, inflow_lakhs, outflow_lakhs FROM annual_flows ORDER BY age`
  );
  return rows;
}

export async function loadLumpSumOutgoes(): Promise<LumpSumRow[]> {
  const { rows } = await pool.query<LumpSumRow>(
    `SELECT age, amount_lakhs FROM lump_sum_outgoes ORDER BY age, id`
  );
  return rows;
}

export async function loadLumpSumInflows(): Promise<LumpSumRow[]> {
  const { rows } = await pool.query<LumpSumRow>(
    `SELECT age, amount_lakhs FROM lump_sum_inflows ORDER BY age, id`
  );
  return rows;
}

export async function loadSwpPlans(): Promise<SwpPlanRow[]> {
  const { rows } = await pool.query<SwpPlanRow>(
    `SELECT start_age, end_age, monthly_amount_lakhs
     FROM swp_plans ORDER BY start_age, id`
  );
  return rows;
}

export function filterLumps(
  lumps: { age: number; amount_lakhs: number }[],
  startAge: number,
  endAge: number
) {
  return lumps.filter((l) => l.age >= startAge && l.age <= endAge);
}

type SettingsField = "inflation_pct" | "start_age" | "end_age";
type BucketField = "corpus_lakhs" | "return_pct";

// Explicit switches (not string interpolation of the field name) so a
// column can never be injected via the input -- only these literals exist.
function settingsColumn(field: SettingsField): string {
  switch (field) {
    case "inflation_pct":
      return "inflation_pct";
    case "start_age":
      return "start_age";
    case "end_age":
      return "end_age";
  }
}

function bucketColumn(field: BucketField): string {
  switch (field) {
    case "corpus_lakhs":
      return "corpus_lakhs";
    case "return_pct":
      return "return_pct";
  }
}

export type UpdateAssumptionInput =
  | { kind: "settings"; field: SettingsField; value: number }
  | { kind: "bucket"; bucket_name: string; field: BucketField; value: number };

export async function updateAssumption(
  input: UpdateAssumptionInput
): Promise<void> {
  if (input.kind === "settings") {
    const column = settingsColumn(input.field);
    await pool.query(
      `UPDATE app_settings SET ${column} = $1, updated_at = NOW() WHERE id = 1`,
      [input.value]
    );
    return;
  }

  const column = bucketColumn(input.field);
  const { rowCount } = await pool.query(
    `UPDATE investment_buckets SET ${column} = $1 WHERE name = $2`,
    [input.value, input.bucket_name]
  );
  if (rowCount === 0) {
    throw new Error(`No investment bucket named "${input.bucket_name}"`);
  }
}

export type AddExpenseInput = { age: number; amount_lakhs: number };

/** One-off outgo at a given age. Only affects the projection if the age
 *  falls within the current app_settings start_age/end_age range. */
export async function addExpense(input: AddExpenseInput): Promise<void> {
  await pool.query(
    `INSERT INTO lump_sum_outgoes (age, amount_lakhs) VALUES ($1, $2)`,
    [input.age, input.amount_lakhs]
  );
}
