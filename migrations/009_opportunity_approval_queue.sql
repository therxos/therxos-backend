-- Opportunity Approval Queue
-- New opportunities from automated scans go here first for admin approval
-- before being deployed to pharmacies

-- Create approval status enum
CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');

-- Pending opportunity types/triggers that need approval
CREATE TABLE IF NOT EXISTS pending_opportunity_types (
  pending_type_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What type of opportunity this is
  recommended_drug_name TEXT NOT NULL,
  opportunity_type VARCHAR(50), -- 'clinical', 'preferred_ndc', 'formulary_switch', etc.

  -- Source of this opportunity type
  source VARCHAR(100), -- 'manual_scan', 'linmas_ndc_import', 'clinical_rules', etc.
  source_details JSONB, -- Additional context about where this came from

  -- Example patients/counts
  sample_patient_count INTEGER DEFAULT 0,
  sample_data JSONB, -- Sample of affected patients for review

  -- Which pharmacies would be affected
  affected_pharmacies UUID[], -- Array of pharmacy_ids
  total_patient_count INTEGER DEFAULT 0,
  estimated_annual_margin NUMERIC(12,2) DEFAULT 0,

  -- Approval workflow
  status approval_status DEFAULT 'pending',
  reviewed_by UUID REFERENCES users(user_id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,

  -- If approved, what trigger was created
  created_trigger_id UUID REFERENCES triggers(trigger_id),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for quick lookup by status
CREATE INDEX idx_pending_opportunity_types_status ON pending_opportunity_types(status);

-- Audit log for approval decisions
CREATE TABLE IF NOT EXISTS opportunity_approval_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_type_id UUID REFERENCES pending_opportunity_types(pending_type_id),
  action VARCHAR(50) NOT NULL, -- 'approved', 'rejected', 'modified', 'reviewed'
  performed_by UUID REFERENCES users(user_id),
  previous_status approval_status,
  new_status approval_status,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Comment explaining the table
COMMENT ON TABLE pending_opportunity_types IS 'Queue for new opportunity types discovered by automated scans that need admin approval before being deployed to pharmacies';
