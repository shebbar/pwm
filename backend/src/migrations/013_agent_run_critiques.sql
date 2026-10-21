-- A critique run (a second agent's review of an earlier chat run, triggered
-- on demand from the chat UI) is stored as just another agent_runs row
-- rather than a parallel table -- it's the same shape (trace, cost,
-- latency, stop_reason all apply unchanged) and this way it automatically
-- shows up in the existing /admin/runs list/stats/detail pages with no new
-- plumbing. kind distinguishes the two; parent_run_id links a critique back
-- to the chat run it reviewed (NULL for ordinary chat runs).
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'chat',
  ADD COLUMN IF NOT EXISTS parent_run_id INTEGER REFERENCES agent_runs(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_kind_check'
  ) THEN
    ALTER TABLE agent_runs
      ADD CONSTRAINT agent_runs_kind_check
      CHECK (kind IN ('chat', 'critique'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_run_id ON agent_runs (parent_run_id);
