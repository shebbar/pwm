-- One-time lump sum inflows at specific ages (e.g. inheritance, property sale)
CREATE TABLE IF NOT EXISTS lump_sum_inflows (
  id SERIAL PRIMARY KEY,
  age SMALLINT NOT NULL,
  amount_lakhs NUMERIC(14, 4) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lump_sum_inflows_age ON lump_sum_inflows (age);
