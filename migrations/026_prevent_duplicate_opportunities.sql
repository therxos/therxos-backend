-- Migration 026: Prevent duplicate opportunities
-- A patient should NEVER have duplicate opportunities for the same recommended drug

-- First, we need to clean up existing duplicates before adding constraint
-- This keeps the OLDEST opportunity for each patient+recommended_drug combo
-- and deletes newer duplicates ONLY if they are 'Not Submitted'

-- Step 1: Delete duplicate 'Not Submitted' opportunities (keep oldest)
DELETE FROM opportunities
WHERE opportunity_id IN (
  SELECT opportunity_id FROM (
    SELECT
      opportunity_id,
      ROW_NUMBER() OVER (
        PARTITION BY pharmacy_id, patient_id, UPPER(COALESCE(recommended_drug_name, ''))
        ORDER BY
          CASE WHEN status != 'Not Submitted' THEN 0 ELSE 1 END,  -- Keep actioned first
          created_at ASC  -- Then oldest
      ) as rn
    FROM opportunities
  ) ranked
  WHERE rn > 1
    AND opportunity_id IN (
      SELECT opportunity_id FROM opportunities WHERE status = 'Not Submitted'
    )
);

-- Step 2: Create unique index to prevent future duplicates
-- Using COALESCE and UPPER for case-insensitive matching
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_patient_drug_unique
ON opportunities (pharmacy_id, patient_id, UPPER(COALESCE(recommended_drug_name, '')))
WHERE status != 'Denied' AND status != 'Declined';

-- Note: This allows a new opportunity if the previous one was Denied/Declined
-- but prevents duplicates for active opportunities
