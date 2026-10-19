-- Asset class per bucket, so agents don't have to guess it from the bucket
-- name (e.g. "Orchid MF" vs "Equity MF" are both equity).
ALTER TABLE investment_buckets
  ADD COLUMN IF NOT EXISTS asset_class TEXT NOT NULL DEFAULT 'equity';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'investment_buckets_asset_class_check'
  ) THEN
    ALTER TABLE investment_buckets
      ADD CONSTRAINT investment_buckets_asset_class_check
      CHECK (asset_class IN ('equity', 'debt', 'cash'));
  END IF;
END $$;

-- Backfill known bucket names from before this column existed (safe to
-- re-run -- a name that doesn't exist in a given DB is just a no-op).
UPDATE investment_buckets SET asset_class = 'equity' WHERE name IN ('Equity MF', 'Orchid MF');
UPDATE investment_buckets SET asset_class = 'debt' WHERE name IN ('FD', 'Orchid FD');
UPDATE investment_buckets SET asset_class = 'cash' WHERE name = 'Savings';
