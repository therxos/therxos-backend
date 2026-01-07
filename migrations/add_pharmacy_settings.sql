-- Add pharmacy settings and excluded prescribers
-- Run this in Supabase SQL Editor

-- Add settings JSONB column to pharmacies
ALTER TABLE pharmacies
ADD COLUMN IF NOT EXISTS settings JSONB DEFAULT '{
  "enabledOpportunityTypes": {
    "missing_therapy": true,
    "therapeutic_interchange": true,
    "ndc_optimization": true
  }
}'::jsonb;

-- Create excluded prescribers table
CREATE TABLE IF NOT EXISTS excluded_prescribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(pharmacy_id) ON DELETE CASCADE,
  prescriber_name VARCHAR(255) NOT NULL,
  prescriber_npi VARCHAR(20),
  prescriber_dea VARCHAR(20),
  reason VARCHAR(500),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(user_id),
  UNIQUE(pharmacy_id, prescriber_npi),
  UNIQUE(pharmacy_id, prescriber_dea)
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_excluded_prescribers_pharmacy ON excluded_prescribers(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_excluded_prescribers_npi ON excluded_prescribers(prescriber_npi);
CREATE INDEX IF NOT EXISTS idx_excluded_prescribers_dea ON excluded_prescribers(prescriber_dea);

-- Update existing pharmacies to have default settings
UPDATE pharmacies
SET settings = '{
  "enabledOpportunityTypes": {
    "missing_therapy": true,
    "therapeutic_interchange": true,
    "ndc_optimization": true
  }
}'::jsonb
WHERE settings IS NULL;
