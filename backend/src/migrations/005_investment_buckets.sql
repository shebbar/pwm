-- Multiple investment buckets, each with corpus and nominal return rate
CREATE TABLE IF NOT EXISTS investment_buckets (
  id SERIAL PRIMARY KEY,
  corpus_lakhs NUMERIC(14, 4) NOT NULL DEFAULT 0,
  return_pct NUMERIC(8, 4) NOT NULL DEFAULT 8
);

-- Migrate legacy single-corpus settings into one bucket when table is empty
INSERT INTO investment_buckets (corpus_lakhs, return_pct)
SELECT s.current_corpus_lakhs, s.portfolio_return_pct
FROM app_settings s
WHERE s.id = 1
  AND NOT EXISTS (SELECT 1 FROM investment_buckets LIMIT 1);
