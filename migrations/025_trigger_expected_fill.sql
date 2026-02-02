-- Migration 025: Add expected fill unit fields to triggers for accurate GP normalization
-- When set, the coverage scanner uses these to correctly normalize GP to 30-day equivalents
-- for products where the standard CEIL(days_supply/30) formula is inaccurate
--
-- Examples:
--   Test strips: expected_qty=100, expected_days_supply=25 (box of 100 lasts 25 days)
--   Diclofenac cream: expected_qty=112, expected_days_supply=30 (tube of 112g lasts 30 days)
--   Pen needles: expected_qty=100, expected_days_supply=30 (box of 100, filled monthly)

ALTER TABLE triggers ADD COLUMN IF NOT EXISTS expected_qty NUMERIC;
ALTER TABLE triggers ADD COLUMN IF NOT EXISTS expected_days_supply INTEGER;
