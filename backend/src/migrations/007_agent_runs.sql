-- Audit log: one row per /api/chat request (model, usage, tool calls, outcome).
CREATE TABLE IF NOT EXISTS agent_runs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  model TEXT NOT NULL,
  user_message TEXT NOT NULL,
  tool_calls JSONB NOT NULL DEFAULT '[]',
  reply TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_created_at ON agent_runs (created_at DESC);
