-- Observability: per-run timing, cost, and a richer trace than the
-- original tool_calls-only column. total_latency_ms/iteration_count/
-- stop_reason/retry_count are real columns (not buried in JSON) so the
-- admin runs page can filter/aggregate on them with plain SQL. llm_calls
-- is a new JSONB column (one entry per LLM call made during the run --
-- several per run is normal, one per loop iteration); tool_calls keeps its
-- existing shape/column (nothing else reads it) but each entry now also
-- carries latencyMs and a sequence number, so the admin UI can merge
-- llm_calls + tool_calls back into one true chronological timeline.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS total_latency_ms INTEGER,
  ADD COLUMN IF NOT EXISTS iteration_count INTEGER,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stop_reason TEXT,
  ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(10, 6),
  ADD COLUMN IF NOT EXISTS llm_calls JSONB NOT NULL DEFAULT '[]';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_stop_reason_check'
  ) THEN
    ALTER TABLE agent_runs
      ADD CONSTRAINT agent_runs_stop_reason_check
      CHECK (stop_reason IS NULL OR stop_reason IN ('answered', 'iteration_cap', 'error', 'awaiting_approval'));
  END IF;
END $$;
