-- Data Quality Issues Table
-- Stores opportunities/records with missing or invalid data that need review before showing to clients

CREATE TABLE IF NOT EXISTS data_quality_issues (
  issue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Source reference
  pharmacy_id UUID NOT NULL REFERENCES pharmacies(pharmacy_id),
  opportunity_id UUID REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,
  prescription_id UUID REFERENCES prescriptions(prescription_id) ON DELETE CASCADE,
  patient_id UUID REFERENCES patients(patient_id),

  -- Issue details
  issue_type VARCHAR(50) NOT NULL CHECK (issue_type IN (
    'missing_prescriber',
    'unknown_prescriber',
    'missing_current_drug',
    'unknown_current_drug',
    'missing_patient_info',
    'invalid_ndc',
    'missing_insurance',
    'other'
  )),
  issue_description TEXT,

  -- Original values (for context)
  original_value TEXT,  -- e.g., "Unknown" or NULL
  field_name VARCHAR(100),  -- e.g., "prescriber_name", "current_drug_name"

  -- Resolution
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'ignored', 'auto_fixed')),
  resolved_value TEXT,  -- The corrected value
  resolved_by UUID REFERENCES users(user_id),
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX idx_dqi_pharmacy_status ON data_quality_issues(pharmacy_id, status);
CREATE INDEX idx_dqi_issue_type ON data_quality_issues(issue_type);
CREATE INDEX idx_dqi_opportunity ON data_quality_issues(opportunity_id);
CREATE INDEX idx_dqi_created ON data_quality_issues(created_at DESC);

-- Function to auto-create issues when opportunities are inserted with bad data
CREATE OR REPLACE FUNCTION check_opportunity_data_quality()
RETURNS TRIGGER AS $$
BEGIN
  -- Check for missing/unknown prescriber
  IF NEW.prescriber_name IS NULL OR UPPER(NEW.prescriber_name) LIKE '%UNKNOWN%' THEN
    INSERT INTO data_quality_issues (
      pharmacy_id, opportunity_id, patient_id, issue_type,
      issue_description, original_value, field_name
    ) VALUES (
      NEW.pharmacy_id, NEW.opportunity_id, NEW.patient_id,
      CASE WHEN NEW.prescriber_name IS NULL THEN 'missing_prescriber' ELSE 'unknown_prescriber' END,
      'Opportunity has missing or unknown prescriber - needs review before showing to client',
      COALESCE(NEW.prescriber_name, 'NULL'),
      'prescriber_name'
    );
  END IF;

  -- Check for missing/unknown current drug
  IF NEW.current_drug_name IS NULL OR UPPER(NEW.current_drug_name) LIKE '%UNKNOWN%' THEN
    INSERT INTO data_quality_issues (
      pharmacy_id, opportunity_id, patient_id, issue_type,
      issue_description, original_value, field_name
    ) VALUES (
      NEW.pharmacy_id, NEW.opportunity_id, NEW.patient_id,
      CASE WHEN NEW.current_drug_name IS NULL THEN 'missing_current_drug' ELSE 'unknown_current_drug' END,
      'Opportunity has missing or unknown current drug - needs review before showing to client',
      COALESCE(NEW.current_drug_name, 'NULL'),
      'current_drug_name'
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on opportunities table
DROP TRIGGER IF EXISTS trg_check_opportunity_quality ON opportunities;
CREATE TRIGGER trg_check_opportunity_quality
  AFTER INSERT ON opportunities
  FOR EACH ROW
  EXECUTE FUNCTION check_opportunity_data_quality();

-- View to get opportunities that should be hidden from clients (have unresolved data issues)
CREATE OR REPLACE VIEW opportunities_with_issues AS
SELECT DISTINCT o.opportunity_id
FROM opportunities o
JOIN data_quality_issues dqi ON dqi.opportunity_id = o.opportunity_id
WHERE dqi.status = 'pending';

-- View for clean opportunities (no pending issues)
CREATE OR REPLACE VIEW clean_opportunities AS
SELECT o.*
FROM opportunities o
WHERE o.opportunity_id NOT IN (
  SELECT opportunity_id FROM data_quality_issues WHERE status = 'pending' AND opportunity_id IS NOT NULL
);

COMMENT ON TABLE data_quality_issues IS 'Stores data quality issues that need review before opportunities can be shown to clients';
