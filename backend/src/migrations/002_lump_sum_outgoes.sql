-- One-time lump sum outgoes at specific ages (e.g. car purchase, education)
CREATE TABLE IF NOT EXISTS lump_sum_outgoes (
  id SERIAL PRIMARY KEY,
  age SMALLINT NOT NULL,
  amount_lakhs NUMERIC(14, 4) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lump_sum_outgoes_age ON lump_sum_outgoes (age);
