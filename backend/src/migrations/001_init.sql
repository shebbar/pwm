-- Single-row app settings (corpus and rate assumptions)
CREATE TABLE IF NOT EXISTS app_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_corpus_lakhs NUMERIC(14, 4) NOT NULL DEFAULT 0,
  portfolio_return_pct NUMERIC(8, 4) NOT NULL DEFAULT 8,
  inflation_pct NUMERIC(8, 4) NOT NULL DEFAULT 5,
  start_age SMALLINT NOT NULL DEFAULT 51,
  end_age SMALLINT NOT NULL DEFAULT 90,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO app_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Optional per-age cash flows (ages between start_age and end_age inclusive)
CREATE TABLE IF NOT EXISTS annual_flows (
  id SERIAL PRIMARY KEY,
  age SMALLINT NOT NULL,
  inflow_lakhs NUMERIC(14, 4) NOT NULL DEFAULT 0,
  outflow_lakhs NUMERIC(14, 4) NOT NULL DEFAULT 0,
  UNIQUE (age)
);

CREATE INDEX IF NOT EXISTS idx_annual_flows_age ON annual_flows (age);
