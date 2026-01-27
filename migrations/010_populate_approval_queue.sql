-- Populate Opportunity Approval Queue with Unauthorized Items
-- Run this AFTER running 009_opportunity_approval_queue.sql
-- Generated: 2026-01-27

-- First, ensure the enum and table exist (run 009 first if not)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'approval_status') THEN
        CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
    END IF;
END $$;

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
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_trigger_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS opportunity_approval_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_type_id UUID,
  action VARCHAR(50) NOT NULL,
  performed_by UUID,
  previous_status approval_status,
  new_status approval_status,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Now populate with all unauthorized opportunity types
-- These are opportunity types that don't match any active trigger

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
  'unknown' as opportunity_type,
  'legacy_scan' as source,
  jsonb_build_object(
    'discovered_date', NOW(),
    'note', 'Opportunity type found in database that does not match any active trigger'
  ) as source_details,
  COUNT(DISTINCT o.patient_id) as total_patient_count,
  COALESCE(SUM(o.annual_margin_gain), 0) as estimated_annual_margin,
  ARRAY_AGG(DISTINCT o.pharmacy_id) as affected_pharmacies
FROM opportunities o
WHERE o.recommended_drug_name NOT IN (
  SELECT recommended_drug FROM triggers WHERE is_enabled = true
)
AND o.recommended_drug_name IS NOT NULL
GROUP BY o.recommended_drug_name
ON CONFLICT DO NOTHING;

-- Show what was added
SELECT
  recommended_drug_name,
  total_patient_count,
  estimated_annual_margin,
  array_length(affected_pharmacies, 1) as pharmacy_count,
  status
FROM pending_opportunity_types
WHERE status = 'pending'
ORDER BY total_patient_count DESC;
