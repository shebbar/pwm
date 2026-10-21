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
  is_critic: boolean;
};

export async function listLlmModels(): Promise<LlmModelRow[]> {
  const { rows } = await pool.query<LlmModelRow>(
    `SELECT id, label, vendor, model_id, is_active, is_critic FROM llm_models ORDER BY created_at`
  );
  return rows;
}

export async function loadActiveLlmModel(): Promise<LlmModelRow | null> {
  const { rows } = await pool.query<LlmModelRow>(
    `SELECT id, label, vendor, model_id, is_active, is_critic FROM llm_models WHERE is_active = true LIMIT 1`
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

/** The critic (runCritic, agent.ts) must use a different model than the
 *  active (chat) one, unless this is the only model in the catalog --
 *  enforced here at write time (and again at read time in
 *  llm/registry.ts's getCriticProvider, in case the active model changes
 *  later and happens to collide with a previously-set critic pick). */
export async function activateCriticLlmModel(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ is_active: boolean }>(
      `SELECT is_active FROM llm_models WHERE id = $1`,
      [id]
    );
    if (rows.length === 0) throw new Error(`No LLM model with id "${id}"`);
    if (rows[0].is_active) {
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*) FROM llm_models`
      );
      if (Number(countRows[0].count) > 1) {
        throw new Error(
          "The critic can't use the same model as the chat agent -- pick a different one (or remove the others to share)."
        );
      }
    }
    await client.query(`UPDATE llm_models SET is_critic = false WHERE is_critic = true`);
    await client.query(`UPDATE llm_models SET is_critic = true WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function removeLlmModel(id: string): Promise<void> {
  const { rows } = await pool.query<{ is_active: boolean; is_critic: boolean }>(
    `SELECT is_active, is_critic FROM llm_models WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) throw new Error(`No LLM model with id "${id}"`);
  if (rows[0].is_active) {
    throw new Error("Cannot delete the active model -- activate a different one first.");
  }
  if (rows[0].is_critic) {
    throw new Error("Cannot delete the critic model -- choose a different one first.");
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

export type AgentRunRow = {
  id: number;
  created_at: string;
  model: string;
  user_message: string;
  reply: string | null;
  tool_calls: unknown;
  llm_calls: unknown;
  input_tokens: number | null;
  output_tokens: number | null;
  status: string;
  error: string | null;
  total_latency_ms: number | null;
  iteration_count: number | null;
  retry_count: number;
  stop_reason: string | null;
  cost_usd: string | null;
  /** 'chat' (the default, ordinary chat turns) or 'critique' (a second
   *  opinion on another run, see parent_run_id) -- same table, same
   *  columns, so a critique run gets the admin list/stats/detail pages for
   *  free instead of needing a parallel schema. */
  kind: string;
  parent_run_id: number | null;
};

export type AgentRunFilters = {
  status?: string;
  stopReason?: string;
  model?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
};

/** List view intentionally omits tool_calls/llm_calls -- those can be
 *  sizeable JSON blobs and the list page doesn't render them; the detail
 *  endpoint below selects everything for one row. */
export async function listAgentRuns(
  filters: AgentRunFilters
): Promise<{ rows: Omit<AgentRunRow, "tool_calls" | "llm_calls">[]; total: number }> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`status = $${params.length}`);
  }
  if (filters.stopReason) {
    params.push(filters.stopReason);
    conditions.push(`stop_reason = $${params.length}`);
  }
  if (filters.model) {
    params.push(filters.model);
    conditions.push(`model = $${params.length}`);
  }
  if (filters.fromDate) {
    params.push(filters.fromDate);
    conditions.push(`created_at >= $${params.length}`);
  }
  if (filters.toDate) {
    params.push(filters.toDate);
    conditions.push(`created_at <= $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const pageSize = Math.min(Math.max(filters.pageSize ?? 20, 1), 100);
  const page = Math.max(filters.page ?? 1, 1);
  const offset = (page - 1) * pageSize;

  const { rows } = await pool.query<Omit<AgentRunRow, "tool_calls" | "llm_calls">>(
    `SELECT id, created_at, model, user_message, reply, input_tokens, output_tokens, status, error,
            total_latency_ms, iteration_count, retry_count, stop_reason, cost_usd, kind, parent_run_id
     FROM agent_runs ${where}
     ORDER BY created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );
  const { rows: countRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) FROM agent_runs ${where}`,
    params
  );
  return { rows, total: Number(countRows[0].count) };
}

export async function getAgentRun(id: number): Promise<AgentRunRow | null> {
  const { rows } = await pool.query<AgentRunRow>(`SELECT * FROM agent_runs WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/** Critique runs (kind='critique') that reviewed this chat run, oldest
 *  first -- you can ask for a second opinion more than once on the same
 *  run, so this is a list, not a single optional row. */
export async function listCritiquesForRun(
  parentRunId: number
): Promise<Omit<AgentRunRow, "tool_calls" | "llm_calls">[]> {
  const { rows } = await pool.query<Omit<AgentRunRow, "tool_calls" | "llm_calls">>(
    `SELECT id, created_at, model, user_message, reply, input_tokens, output_tokens, status, error,
            total_latency_ms, iteration_count, retry_count, stop_reason, cost_usd, kind, parent_run_id
     FROM agent_runs
     WHERE parent_run_id = $1
     ORDER BY created_at ASC`,
    [parentRunId]
  );
  return rows;
}

export type AgentRunStats = {
  runsPerDay: { day: string; count: number }[];
  failureRate: number;
  avgCostUsd: number | null;
  p95LatencyMs: number | null;
  topTools: { name: string; count: number }[];
};

export async function getAgentRunStats(): Promise<AgentRunStats> {
  const [runsPerDay, failure, avgCost, p95, topTools] = await Promise.all([
    pool.query<{ day: string; count: string }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*) AS count
       FROM agent_runs
       WHERE created_at >= NOW() - INTERVAL '14 days'
       GROUP BY day
       ORDER BY day DESC`
    ),
    pool.query<{ rate: string | null }>(
      `SELECT (COUNT(*) FILTER (WHERE status = 'error'))::float / NULLIF(COUNT(*), 0) AS rate
       FROM agent_runs`
    ),
    pool.query<{ avg: string | null }>(`SELECT AVG(cost_usd) AS avg FROM agent_runs WHERE cost_usd IS NOT NULL`),
    pool.query<{ p95: string | null }>(
      `SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY total_latency_ms) AS p95
       FROM agent_runs WHERE total_latency_ms IS NOT NULL`
    ),
    pool.query<{ name: string; count: string }>(
      `SELECT elem->>'name' AS name, COUNT(*) AS count
       FROM agent_runs, jsonb_array_elements(tool_calls) AS elem
       GROUP BY name
       ORDER BY count DESC
       LIMIT 10`
    ),
  ]);

  return {
    runsPerDay: runsPerDay.rows.map((r) => ({ day: r.day, count: Number(r.count) })),
    failureRate: failure.rows[0]?.rate != null ? Number(failure.rows[0].rate) : 0,
    avgCostUsd: avgCost.rows[0]?.avg != null ? Number(avgCost.rows[0].avg) : null,
    p95LatencyMs: p95.rows[0]?.p95 != null ? Number(p95.rows[0].p95) : null,
    topTools: topTools.rows.map((r) => ({ name: r.name, count: Number(r.count) })),
  };
}
