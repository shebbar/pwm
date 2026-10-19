-- Human-in-the-loop approvals: a "propose_*" tool writes here instead of
-- the real tables; nothing is persisted to the actual plan until a human
-- approves via POST /api/actions/:id/approve. before/after_summary are
-- snapshotted at propose time (depletion age + corpus at end age) so the
-- UI can show impact without recomputing, and so an eval/audit later can
-- see exactly what the agent claimed at the time it proposed the change.
CREATE TABLE IF NOT EXISTS pending_actions (
  id SERIAL PRIMARY KEY,
  agent_run_id INTEGER REFERENCES agent_runs(id),
  tool_name TEXT NOT NULL,
  proposed_input JSONB NOT NULL,
  before_summary JSONB NOT NULL,
  after_summary JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  reason TEXT,
  decided_at TIMESTAMPTZ,
  decided_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes'
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_status ON pending_actions (status);
