-- Migration: 003_trigger_bin_group_pricing.sql
-- BIN/Group Pricing Enhancement for TheRxOS V2
-- Run this in Supabase SQL Editor

-- ===========================================
-- ENHANCE TRIGGER_BIN_VALUES TABLE
-- Add Group support and verification status
-- ===========================================

-- Add new columns
ALTER TABLE trigger_bin_values
ADD COLUMN IF NOT EXISTS insurance_group VARCHAR(50) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS coverage_status VARCHAR(20) DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS verified_claim_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS avg_reimbursement NUMERIC(10,2);

-- Add constraint for coverage_status values
ALTER TABLE trigger_bin_values
DROP CONSTRAINT IF EXISTS trigger_bin_values_coverage_status_check;

ALTER TABLE trigger_bin_values
ADD CONSTRAINT trigger_bin_values_coverage_status_check
CHECK (coverage_status IN ('works', 'excluded', 'verified', 'unknown'));

-- Migrate is_excluded to coverage_status
UPDATE trigger_bin_values
SET coverage_status = CASE
  WHEN is_excluded = true THEN 'excluded'
  ELSE 'works'
END
WHERE coverage_status = 'unknown' OR coverage_status IS NULL;

-- Drop old unique constraint and create new one that includes group
DROP INDEX IF EXISTS trigger_bin_values_trigger_id_insurance_bin_key;

-- Create new unique index that handles NULL insurance_group
CREATE UNIQUE INDEX IF NOT EXISTS trigger_bin_values_unique
ON trigger_bin_values(trigger_id, insurance_bin, COALESCE(insurance_group, ''));

-- Create index for group lookups
CREATE INDEX IF NOT EXISTS idx_trigger_bin_values_group
ON trigger_bin_values(insurance_group);

-- Create index for coverage status
CREATE INDEX IF NOT EXISTS idx_trigger_bin_values_coverage
ON trigger_bin_values(coverage_status);

-- ===========================================
-- COVERAGE STATUS VALUES:
-- 'works'    - Manual confirmation that this BIN/Group has coverage
-- 'excluded' - Does not work, skip this BIN/Group
-- 'verified' - Confirmed by actual claim data (auto-detected)
-- 'unknown'  - No information yet (use default pricing)
-- ===========================================

-- Success message
DO $$ BEGIN RAISE NOTICE 'BIN/Group pricing enhancement migration completed!'; END $$;
