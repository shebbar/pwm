-- Systematic withdrawal plans: fixed monthly amount between start and end age (inclusive)
CREATE TABLE IF NOT EXISTS swp_plans (
  id SERIAL PRIMARY KEY,
  start_age SMALLINT NOT NULL,
  end_age SMALLINT NOT NULL,
  monthly_amount_lakhs NUMERIC(14, 4) NOT NULL DEFAULT 0,
  CHECK (start_age <= end_age)
);

CREATE INDEX IF NOT EXISTS idx_swp_plans_start_age ON swp_plans (start_age);
