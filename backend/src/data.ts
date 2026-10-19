import { pool } from "./db.js";
import { PENDING_ACTION_TTL_MINUTES } from "./config.js";
import type {
  FlowRow,
  InvestmentBucketRow,
  LumpSumRow,
  SettingsRow,
  SwpPlanRow,
} from "./projection.js";

// Minimal duck-typed interface rather than importing pg's Pool/PoolClient
// union -- update/addExpense below need to run either standalone (the
// shared pool) or inside an existing transaction (approvePendingAction's
// client), and both satisfy this shape.
type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};

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
  input: UpdateAssumptionInput,
  db: Queryable = pool
): Promise<void> {
  if (input.kind === "settings") {
    const column = settingsColumn(input.field);
    await db.query(
      `UPDATE app_settings SET ${column} = $1, updated_at = NOW() WHERE id = 1`,
      [input.value]
    );
    return;
  }

  const column = bucketColumn(input.field);
  const { rowCount } = await db.query(
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
export async function addExpense(
  input: AddExpenseInput,
  db: Queryable = pool
): Promise<void> {
  await db.query(
    `INSERT INTO lump_sum_outgoes (age, amount_lakhs) VALUES ($1, $2)`,
    [input.age, input.amount_lakhs]
  );
}

export type LlmModelRow = {
  id: string;
  label: string;
  vendor: string;
  model_id: string;
  is_active: boolean;
};

export async function listLlmModels(): Promise<LlmModelRow[]> {
  const { rows } = await pool.query<LlmModelRow>(
    `SELECT id, label, vendor, model_id, is_active FROM llm_models ORDER BY created_at`
  );
  return rows;
}

export async function loadActiveLlmModel(): Promise<LlmModelRow | null> {
  const { rows } = await pool.query<LlmModelRow>(
    `SELECT id, label, vendor, model_id, is_active FROM llm_models WHERE is_active = true LIMIT 1`
  );
  return rows[0] ?? null;
}

export type AddLlmModelInput = {
  id: string;
  label: string;
  vendor: string;
  model_id: string;
};

export async function addLlmModel(input: AddLlmModelInput): Promise<void> {
  await pool.query(
    `INSERT INTO llm_models (id, label, vendor, model_id) VALUES ($1, $2, $3, $4)`,
    [input.id, input.label, input.vendor, input.model_id]
  );
}

export async function activateLlmModel(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query(`SELECT 1 FROM llm_models WHERE id = $1`, [id]);
    if (rowCount === 0) throw new Error(`No LLM model with id "${id}"`);
    await client.query(`UPDATE llm_models SET is_active = false WHERE is_active = true`);
    await client.query(`UPDATE llm_models SET is_active = true WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function removeLlmModel(id: string): Promise<void> {
  const { rows } = await pool.query<{ is_active: boolean }>(
    `SELECT is_active FROM llm_models WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) throw new Error(`No LLM model with id "${id}"`);
  if (rows[0].is_active) {
    throw new Error("Cannot delete the active model -- activate a different one first.");
  }
  await pool.query(`DELETE FROM llm_models WHERE id = $1`, [id]);
}

export type PendingActionStatus = "pending" | "approved" | "rejected" | "expired";

export type PendingActionRow = {
  id: number;
  agent_run_id: number | null;
  tool_name: string;
  proposed_input: unknown;
  before_summary: unknown;
  after_summary: unknown;
  status: PendingActionStatus;
  reason: string | null;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
  expires_at: string;
};

export async function insertPendingAction(input: {
  toolName: string;
  proposedInput: unknown;
  beforeSummary: unknown;
  afterSummary: unknown;
}): Promise<number> {
  const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MINUTES * 60_000);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO pending_actions (tool_name, proposed_input, before_summary, after_summary, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      input.toolName,
      JSON.stringify(input.proposedInput),
      JSON.stringify(input.beforeSummary),
      JSON.stringify(input.afterSummary),
      expiresAt,
    ]
  );
  return rows[0].id;
}

/** Links proposals surfaced during an agent run to that run's audit row --
 *  done after the fact because agent_runs is only written once the run
 *  completes, while a proposal is created mid-loop (see agent.ts). */
export async function linkPendingActionsToRun(
  agentRunId: number,
  pendingActionIds: number[]
): Promise<void> {
  if (pendingActionIds.length === 0) return;
  await pool.query(
    `UPDATE pending_actions SET agent_run_id = $1 WHERE id = ANY($2::int[])`,
    [agentRunId, pendingActionIds]
  );
}

async function expireStalePendingActions(db: Queryable = pool): Promise<void> {
  await db.query(
    `UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < NOW()`
  );
}

export async function listPendingActions(
  status?: PendingActionStatus
): Promise<PendingActionRow[]> {
  await expireStalePendingActions();
  const { rows } = status
    ? await pool.query<PendingActionRow>(
        `SELECT * FROM pending_actions WHERE status = $1 ORDER BY created_at DESC`,
        [status]
      )
    : await pool.query<PendingActionRow>(
        `SELECT * FROM pending_actions ORDER BY created_at DESC`
      );
  return rows;
}

export type DecidePendingActionOutcome =
  | { outcome: "not_found" }
  | { outcome: "already_decided"; row: PendingActionRow }
  | { outcome: "expired"; row: PendingActionRow }
  | { outcome: "decided"; row: PendingActionRow };

const APPLY_BY_TOOL_NAME: Record<
  string,
  (input: any, db: Queryable) => Promise<void>
> = {
  propose_update_assumption: (input, db) => updateAssumption(input, db),
  propose_add_expense: (input, db) => addExpense(input, db),
};

/** Shared by approve/reject: locks the row, lazily expires it if its TTL
 *  passed, and short-circuits if it's already been decided -- this is what
 *  makes approving (or rejecting) the same id twice a no-op rather than a
 *  double-write. Returns null once it has already sent a response-worthy
 *  outcome back, so the caller can just `return` that outcome without
 *  doing its own work. */
async function lockPendingAction(
  client: Queryable,
  id: number
): Promise<
  { shortCircuit: DecidePendingActionOutcome } | { shortCircuit: null; row: PendingActionRow }
> {
  await expireStalePendingActions(client);
  const { rows } = await client.query(
    `SELECT * FROM pending_actions WHERE id = $1 FOR UPDATE`,
    [id]
  );
  const row = rows[0] as PendingActionRow | undefined;
  if (!row) return { shortCircuit: { outcome: "not_found" } };
  if (row.status === "expired") return { shortCircuit: { outcome: "expired", row } };
  if (row.status !== "pending") return { shortCircuit: { outcome: "already_decided", row } };
  return { shortCircuit: null, row };
}

export async function approvePendingAction(
  id: number,
  decidedBy: string
): Promise<DecidePendingActionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await lockPendingAction(client, id);
    if (locked.shortCircuit) {
      await client.query("COMMIT");
      return locked.shortCircuit;
    }

    const apply = APPLY_BY_TOOL_NAME[locked.row.tool_name];
    if (!apply) {
      throw new Error(`No apply handler for proposal tool "${locked.row.tool_name}"`);
    }
    await apply(locked.row.proposed_input, client);

    const { rows } = await client.query<PendingActionRow>(
      `UPDATE pending_actions SET status = 'approved', decided_at = NOW(), decided_by = $2
       WHERE id = $1 RETURNING *`,
      [id, decidedBy]
    );
    await client.query("COMMIT");
    return { outcome: "decided", row: rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectPendingAction(
  id: number,
  decidedBy: string,
  reason?: string
): Promise<DecidePendingActionOutcome> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await lockPendingAction(client, id);
    if (locked.shortCircuit) {
      await client.query("COMMIT");
      return locked.shortCircuit;
    }

    const { rows } = await client.query<PendingActionRow>(
      `UPDATE pending_actions SET status = 'rejected', decided_at = NOW(), decided_by = $2, reason = $3
       WHERE id = $1 RETURNING *`,
      [id, decidedBy, reason ?? null]
    );
    await client.query("COMMIT");
    return { outcome: "decided", row: rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
