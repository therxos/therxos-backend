-- Complete Approval Queue Setup
-- Run this in Supabase SQL Editor
-- This creates the tables AND populates them with unauthorized items
-- Generated: 2026-01-27

-- ============================================
-- STEP 1: Create the approval_status enum
-- ============================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approval_status') THEN
        CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
    END IF;
END $$;

-- ============================================
-- STEP 2: Create pending_opportunity_types table
-- ============================================
CREATE TABLE IF NOT EXISTS pending_opportunity_types (
  pending_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommended_drug_name TEXT NOT NULL,
  opportunity_type VARCHAR(50),
  source VARCHAR(100),
  source_details JSONB,
  sample_data JSONB,
  affected_pharmacies UUID[],
  total_patient_count INTEGER DEFAULT 0,
  estimated_annual_margin NUMERIC(12,2) DEFAULT 0,
  status approval_status DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(user_id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_trigger_id UUID REFERENCES triggers(trigger_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pending_opportunity_types_status
ON pending_opportunity_types(status);

-- ============================================
-- STEP 3: Create approval log table
-- ============================================
CREATE TABLE IF NOT EXISTS opportunity_approval_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_type_id UUID REFERENCES pending_opportunity_types(pending_type_id),
  action VARCHAR(50) NOT NULL,
  performed_by UUID REFERENCES users(user_id),
  previous_status approval_status,
  new_status approval_status,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- STEP 4: Populate with unauthorized opportunity types
-- ============================================
INSERT INTO pending_opportunity_types (
  recommended_drug_name,
  opportunity_type,
  source,
  source_details,
  total_patient_count,
  estimated_annual_margin,
  affected_pharmacies
)
SELECT
  o.recommended_drug_name,
  COALESCE(o.opportunity_type, 'unknown') as opportunity_type,
  'legacy_scan' as source,
  jsonb_build_object(
    'discovered_date', NOW(),
    'first_seen', MIN(o.created_at),
    'last_seen', MAX(o.created_at),
    'note', 'Opportunity type found that does not match any active trigger'
  ) as source_details,
  COUNT(DISTINCT o.patient_id) as total_patient_count,
  COALESCE(SUM(o.annual_margin_gain), 0) as estimated_annual_margin,
  ARRAY_AGG(DISTINCT o.pharmacy_id) as affected_pharmacies
FROM opportunities o
WHERE o.recommended_drug_name NOT IN (
  SELECT recommended_drug FROM triggers WHERE is_enabled = true
)
AND o.recommended_drug_name IS NOT NULL
GROUP BY o.recommended_drug_name, o.opportunity_type
ON CONFLICT DO NOTHING;

-- ============================================
-- STEP 5: Show results
-- ============================================
SELECT
  recommended_drug_name,
  total_patient_count as patients,
  estimated_annual_margin as est_margin,
  array_length(affected_pharmacies, 1) as pharmacies,
  status
FROM pending_opportunity_types
WHERE status = 'pending'
ORDER BY total_patient_count DESC
LIMIT 50;

-- Summary
SELECT
  COUNT(*) as total_pending_types,
  SUM(total_patient_count) as total_patients_affected,
  SUM(estimated_annual_margin) as total_estimated_margin
FROM pending_opportunity_types
WHERE status = 'pending';
