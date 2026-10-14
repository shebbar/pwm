-- Runtime override for which LLM provider/model the agent uses. NULL means
-- "use the PORTFOLIO_LLM_MODEL env var default". The point of a DB-backed
-- override (vs. only an env var) is being able to flip providers without a
-- redeploy -- e.g. during a vendor outage.
CREATE TABLE IF NOT EXISTS agent_config (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  llm_provider TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO agent_config (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
