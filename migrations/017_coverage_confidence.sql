-- Migration: Coverage Confidence System
-- Adds trigger_id to opportunities for coverage lookup
-- Adds contract_id and plan_name to trigger_bin_values for future enrichment

-- 1. Add trigger_id to opportunities
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS trigger_id UUID REFERENCES triggers(trigger_id);

-- 2. Add contract/plan fields to trigger_bin_values
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS contract_id TEXT;
ALTER TABLE trigger_bin_values ADD COLUMN IF NOT EXISTS plan_name TEXT;

-- 3. Create index for fast coverage lookups
CREATE INDEX IF NOT EXISTS idx_opportunities_trigger_id ON opportunities(trigger_id);

-- 4. Backfill trigger_id on existing opportunities
UPDATE opportunities o
SET trigger_id = t.trigger_id
FROM triggers t
WHERE o.trigger_id IS NULL
  AND o.opportunity_type = t.trigger_type
  AND o.pharmacy_id IN (
    SELECT pharmacy_id FROM pharmacy_triggers pt WHERE pt.trigger_id = t.trigger_id
  );

-- 5. Backfill "Didn't Work" exclusions into trigger_bin_values
INSERT INTO trigger_bin_values (trigger_id, insurance_bin, insurance_group, is_excluded, coverage_status, verified_at)
SELECT DISTINCT
  o.trigger_id,
  COALESCE(pr.insurance_bin, pat.primary_insurance_bin),
  COALESCE(pr.insurance_group, pat.primary_insurance_group),
  true,
  'excluded',
  NOW()
FROM opportunities o
LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
LEFT JOIN patients pat ON pat.patient_id = o.patient_id
WHERE o.status = 'Didn''t Work'
  AND o.trigger_id IS NOT NULL
  AND COALESCE(pr.insurance_bin, pat.primary_insurance_bin) IS NOT NULL
ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
DO UPDATE SET is_excluded = true, coverage_status = 'excluded', verified_at = NOW();
