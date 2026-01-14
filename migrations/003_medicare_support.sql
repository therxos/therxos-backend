-- Medicare Part D Support Migration
-- Adds tables for Medicare formulary data, drug pricing, and opportunity coverage verification

-- Medicare Formulary Cache Table
-- Stores formulary data from CMS API and 832 files
CREATE TABLE IF NOT EXISTS medicare_formulary (
  formulary_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id VARCHAR(10) NOT NULL,  -- e.g., H2226, S5678, R1234
  plan_id VARCHAR(10),                -- e.g., 001, 002
  ndc VARCHAR(11) NOT NULL,
  tier INT,                           -- 1-6
  prior_auth_required BOOLEAN DEFAULT FALSE,
  step_therapy_required BOOLEAN DEFAULT FALSE,
  quantity_limit INT,
  quantity_limit_days INT,
  reimbursement_rate DECIMAL(10,2),   -- From 832 or NADAC
  estimated_copay DECIMAL(10,2),
  effective_date DATE,
  expiration_date DATE,
  source VARCHAR(50),                 -- 'cms_api', '832_mckesson', etc.
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  UNIQUE(contract_id, ndc)
);

-- Drug Pricing Table
-- Stores WAC, contract pricing, and rebate data from 832 files
CREATE TABLE IF NOT EXISTS drug_pricing (
  pricing_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ndc VARCHAR(11) NOT NULL,
  contract_id VARCHAR(50),            -- Wholesaler/PBM contract
  wac DECIMAL(10,2),                  -- Wholesale Acquisition Cost
  contract_price DECIMAL(10,2),       -- Contract/Net price
  rebate_amount DECIMAL(10,2),        -- Rebate per unit
  reimbursement_rate DECIMAL(10,2),   -- Calculated: contract_price - rebate
  effective_date DATE,
  expiration_date DATE,
  source VARCHAR(50) NOT NULL,        -- 'mckesson', 'amerisource', 'cardinal', etc.
  batch_id VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  UNIQUE(ndc, contract_id, source)
);

-- NADAC Pricing Table (optional - for CMS NADAC data)
CREATE TABLE IF NOT EXISTS nadac_pricing (
  nadac_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ndc VARCHAR(11) NOT NULL,
  nadac_per_unit DECIMAL(10,4),
  pricing_unit VARCHAR(10),           -- 'EA', 'ML', 'GM'
  effective_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(ndc, effective_date)
);

-- Add Medicare-specific columns to opportunities table
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_verified_at TIMESTAMPTZ;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_covered BOOLEAN;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_tier INT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_prior_auth BOOLEAN;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_step_therapy BOOLEAN;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_quantity_limit INT;
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_estimated_copay DECIMAL(10,2);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS medicare_reimbursement_rate DECIMAL(10,2);
ALTER TABLE opportunities ADD COLUMN IF NOT EXISTS margin_source VARCHAR(50); -- 'estimated', 'medicare_verified', '832_data', etc.

-- Add Medicare-related columns to patients table if not present
ALTER TABLE patients ADD COLUMN IF NOT EXISTS medicare_beneficiary_id VARCHAR(20);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS part_d_contract_id VARCHAR(10);
ALTER TABLE patients ADD COLUMN IF NOT EXISTS part_d_plan_id VARCHAR(10);

-- Add Medicare-related columns to prescriptions table if not present
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS contract_id VARCHAR(20);
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS plan_name VARCHAR(100);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_medicare_formulary_contract ON medicare_formulary(contract_id);
CREATE INDEX IF NOT EXISTS idx_medicare_formulary_ndc ON medicare_formulary(ndc);
CREATE INDEX IF NOT EXISTS idx_medicare_formulary_contract_ndc ON medicare_formulary(contract_id, ndc);

CREATE INDEX IF NOT EXISTS idx_drug_pricing_ndc ON drug_pricing(ndc);
CREATE INDEX IF NOT EXISTS idx_drug_pricing_contract ON drug_pricing(contract_id);
CREATE INDEX IF NOT EXISTS idx_drug_pricing_source ON drug_pricing(source);

CREATE INDEX IF NOT EXISTS idx_opportunities_medicare_verified ON opportunities(medicare_verified_at) WHERE medicare_verified_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_opportunities_medicare_covered ON opportunities(medicare_covered) WHERE medicare_covered IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prescriptions_contract ON prescriptions(contract_id) WHERE contract_id IS NOT NULL;

-- Pricing file ingestion log
CREATE TABLE IF NOT EXISTS pricing_file_logs (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name VARCHAR(255) NOT NULL,
  file_type VARCHAR(20),              -- '832', 'csv', 'nadac'
  source VARCHAR(50),
  records_processed INT,
  records_inserted INT,
  records_updated INT,
  errors INT,
  batch_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'processing',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  error_message TEXT
);

-- Comments for documentation
COMMENT ON TABLE medicare_formulary IS 'Medicare Part D formulary cache from CMS API and 832 files';
COMMENT ON TABLE drug_pricing IS 'Drug pricing data from 832 EDI files including WAC, contract prices, and rebates';
COMMENT ON TABLE nadac_pricing IS 'CMS NADAC (National Average Drug Acquisition Cost) data';
COMMENT ON COLUMN opportunities.medicare_verified_at IS 'When Medicare coverage was last verified via CMS API';
COMMENT ON COLUMN opportunities.margin_source IS 'Source of margin calculation: estimated, medicare_verified, 832_data';
