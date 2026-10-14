-- Catalog of available LLM models, and which one is active. Replaces
-- agent_config's single llm_provider override: the catalog itself (label,
-- vendor, model_id) is now data, not just a choice among hardcoded options.
--
-- max_tokens is deliberately NOT a column here -- it's a tested,
-- model-specific safety value (see llm/anthropic/models.ts), not something
-- an admin UI should let someone guess at. A model is only safe to use once
-- it has a corresponding code-level entry there.
CREATE TABLE IF NOT EXISTS llm_models (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  vendor TEXT NOT NULL,
  model_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one active row, enforced at the DB level, not by convention.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_llm_model ON llm_models (is_active) WHERE is_active;

INSERT INTO llm_models (id, label, vendor, model_id, is_active) VALUES
  ('claude-haiku', 'Claude Haiku (fast, cheap)', 'anthropic', 'claude-haiku-4-5-20251001', true),
  ('claude-sonnet', 'Claude Sonnet (slower, more capable)', 'anthropic', 'claude-sonnet-5', false)
ON CONFLICT (id) DO NOTHING;

DROP TABLE IF EXISTS agent_config;
