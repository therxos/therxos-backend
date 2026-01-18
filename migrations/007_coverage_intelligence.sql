-- Migration: 007_coverage_intelligence.sql
-- Coverage Intelligence System for TheRxOS V2
-- Fixes missing tables and adds workability scoring

-- ===========================================
-- FORMULARY ITEMS TABLE (was missing!)
-- Caches formulary data from multiple sources
-- ===========================================
CREATE TABLE IF NOT EXISTS formulary_items (
  formulary_item_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Plan identification (PRIMARY: contract_id + plan_name, SECONDARY: bin + group_number)
  contract_id VARCHAR(20),          -- Medicare contract (H1234) or commercial
  plan_name VARCHAR(100),           -- Plan name/ID within contract
  bin VARCHAR(10),                  -- BIN for commercial plans
  group_number VARCHAR(50),         -- Group number (primary for commercial matching)

  -- Drug identification
  ndc VARCHAR(13) NOT NULL,         -- 11-digit NDC
  rxcui VARCHAR(20),                -- RxNorm CUI
  drug_name VARCHAR(255),
  generic_name VARCHAR(255),

  -- Formulary status
  tier INTEGER,                     -- 1-6 for Part D, varies for commercial
  tier_description VARCHAR(100),
  preferred BOOLEAN DEFAULT false,
  on_formulary BOOLEAN DEFAULT true,

  -- Utilization management
  prior_auth_required BOOLEAN DEFAULT false,
  step_therapy_required BOOLEAN DEFAULT false,
  quantity_limit INTEGER,
  quantity_limit_days INTEGER,
  specialty_drug BOOLEAN DEFAULT false,

  -- Pricing (if known)
  estimated_copay NUMERIC(10,2),
  coinsurance_pct NUMERIC(5,2),
  reimbursement_rate NUMERIC(10,4),

  -- Metadata
  data_source VARCHAR(50),          -- 'cms_api', 'edi_832', 'manual', 'scrape'
  effective_date DATE,
  expiration_date DATE,
  last_verified_at TIMESTAMPTZ,
  verification_status VARCHAR(20) DEFAULT 'unverified',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint per plan/drug combination
  CONSTRAINT uq_formulary_item UNIQUE (contract_id, plan_name, ndc)
);

CREATE INDEX IF NOT EXISTS idx_formulary_ndc ON formulary_items(ndc);
CREATE INDEX IF NOT EXISTS idx_formulary_contract ON formulary_items(contract_id, plan_name);
CREATE INDEX IF NOT EXISTS idx_formulary_bin_group ON formulary_items(bin, group_number);
CREATE INDEX IF NOT EXISTS idx_formulary_preferred ON formulary_items(preferred) WHERE preferred = true;
CREATE INDEX IF NOT EXISTS idx_formulary_tier ON formulary_items(tier);


-- ===========================================
-- INSURANCE CONTRACTS TABLE (was missing!)
-- Maps BIN/PCN/Group to contract details
-- ===========================================
CREATE TABLE IF NOT EXISTS insurance_contracts (
  contract_id_internal UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification (PRIMARY: contract_id for Medicare, BIN + GROUP for commercial)
  contract_id VARCHAR(20),          -- Medicare contract (H1234)
  plan_name VARCHAR(100),           -- Plan name within contract
  bin VARCHAR(10),
  group_number VARCHAR(50),         -- Group for commercial matching

  -- Contract details
  payer_name VARCHAR(255),
  plan_type VARCHAR(50),            -- 'medicare_part_d', 'medicaid', 'commercial', 'pbm'

  -- Coverage info
  formulary_id VARCHAR(50),
  formulary_url TEXT,
  has_formulary_data BOOLEAN DEFAULT false,

  -- Contact
  pa_phone VARCHAR(20),
  pa_fax VARCHAR(20),
  appeals_phone VARCHAR(20),
  website TEXT,

  -- Data quality
  data_completeness INTEGER DEFAULT 0,  -- 0-100%
  last_updated_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_insurance_contract UNIQUE (contract_id, plan_name, bin, group_number)
);

CREATE INDEX IF NOT EXISTS idx_insurance_contract ON insurance_contracts(contract_id);
CREATE INDEX IF NOT EXISTS idx_insurance_bin_group ON insurance_contracts(bin, group_number);
CREATE INDEX IF NOT EXISTS idx_insurance_plan_type ON insurance_contracts(plan_type);


-- ===========================================
-- COVERAGE VERIFICATION LOG
-- Tracks every coverage check attempt
-- ===========================================
CREATE TABLE IF NOT EXISTS coverage_verification_log (
  log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What we checked
  opportunity_id UUID REFERENCES opportunities(opportunity_id),
  patient_id UUID REFERENCES patients(patient_id),
  pharmacy_id UUID REFERENCES pharmacies(pharmacy_id),

  -- Drug info
  ndc VARCHAR(13),
  drug_name VARCHAR(255),

  -- Insurance info (matches prescriptions table naming)
  contract_id VARCHAR(20),
  plan_name VARCHAR(100),
  bin VARCHAR(10),
  group_number VARCHAR(50),

  -- Verification result
  verification_source VARCHAR(50),  -- 'cms_api', 'local_cache', 'edi_832', 'manual'
  verification_success BOOLEAN,
  error_message TEXT,

  -- Coverage result (if successful)
  is_covered BOOLEAN,
  tier INTEGER,
  prior_auth BOOLEAN,
  step_therapy BOOLEAN,
  quantity_limit INTEGER,
  estimated_copay NUMERIC(10,2),
  reimbursement_rate NUMERIC(10,4),

  -- Performance
  response_time_ms INTEGER,
  api_endpoint TEXT,

  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coverage_log_opp ON coverage_verification_log(opportunity_id);
CREATE INDEX IF NOT EXISTS idx_coverage_log_pharmacy ON coverage_verification_log(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_coverage_log_success ON coverage_verification_log(verification_success);
CREATE INDEX IF NOT EXISTS idx_coverage_log_date ON coverage_verification_log(created_at DESC);


-- ===========================================
-- WORKABILITY SCORES
-- Scores each opportunity on how actionable it is
-- ===========================================
CREATE TABLE IF NOT EXISTS opportunity_workability (
  workability_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID UNIQUE NOT NULL REFERENCES opportunities(opportunity_id) ON DELETE CASCADE,

  -- Overall score (0-100)
  workability_score INTEGER NOT NULL DEFAULT 0,
  workability_grade VARCHAR(1),     -- A, B, C, D, F

  -- Component scores (each 0-100)
  coverage_score INTEGER DEFAULT 0,       -- Is drug covered? Tier? PA?
  margin_score INTEGER DEFAULT 0,         -- Potential margin gain confidence
  patient_score INTEGER DEFAULT 0,        -- Patient fill history, compliance
  prescriber_score INTEGER DEFAULT 0,     -- Prescriber approval rate
  data_quality_score INTEGER DEFAULT 0,   -- Do we have all needed data?

  -- Flags for issues
  issues JSONB DEFAULT '[]',              -- Array of issue objects
  missing_data TEXT[],                    -- What data is missing
  warnings TEXT[],                        -- Non-blocking concerns
  blockers TEXT[],                        -- Blocking issues

  -- Recommendations
  next_action VARCHAR(100),
  action_notes TEXT,

  -- Metadata
  scored_at TIMESTAMPTZ DEFAULT NOW(),
  score_version INTEGER DEFAULT 1,

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workability_score ON opportunity_workability(workability_score DESC);
CREATE INDEX IF NOT EXISTS idx_workability_grade ON opportunity_workability(workability_grade);


-- ===========================================
-- CMS PLAN REFERENCE
-- Master list of Medicare Part D plans
-- ===========================================
CREATE TABLE IF NOT EXISTS cms_plan_reference (
  plan_ref_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CMS identifiers
  contract_id VARCHAR(20) NOT NULL,       -- H1234
  plan_id VARCHAR(20) NOT NULL,           -- 001, 002, etc.
  segment_id VARCHAR(10),

  -- Plan details
  organization_name VARCHAR(255),
  plan_name VARCHAR(255),
  plan_type VARCHAR(50),                  -- 'PDP', 'MAPD', 'MMP'

  -- Service area
  state_code VARCHAR(2),
  county_codes TEXT[],
  region VARCHAR(50),

  -- Formulary
  formulary_id VARCHAR(50),
  formulary_version VARCHAR(20),

  -- Status
  is_active BOOLEAN DEFAULT true,
  plan_year INTEGER,

  -- Data freshness
  last_synced_at TIMESTAMPTZ,
  sync_source VARCHAR(50),

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_cms_plan UNIQUE (contract_id, plan_id, plan_year)
);

CREATE INDEX IF NOT EXISTS idx_cms_plan_contract ON cms_plan_reference(contract_id);
CREATE INDEX IF NOT EXISTS idx_cms_plan_state ON cms_plan_reference(state_code);
CREATE INDEX IF NOT EXISTS idx_cms_plan_active ON cms_plan_reference(is_active) WHERE is_active = true;


-- ===========================================
-- COVERAGE INTELLIGENCE METRICS
-- Aggregated stats for monitoring
-- ===========================================
CREATE TABLE IF NOT EXISTS coverage_intelligence_metrics (
  metric_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  pharmacy_id UUID REFERENCES pharmacies(pharmacy_id),
  metric_date DATE NOT NULL,

  -- Verification stats
  total_verifications INTEGER DEFAULT 0,
  successful_verifications INTEGER DEFAULT 0,
  failed_verifications INTEGER DEFAULT 0,

  -- Coverage stats
  covered_count INTEGER DEFAULT 0,
  not_covered_count INTEGER DEFAULT 0,
  unknown_count INTEGER DEFAULT 0,

  -- Source breakdown
  cms_api_hits INTEGER DEFAULT 0,
  local_cache_hits INTEGER DEFAULT 0,
  edi_832_hits INTEGER DEFAULT 0,
  fallback_hits INTEGER DEFAULT 0,

  -- Performance
  avg_response_time_ms INTEGER,
  p95_response_time_ms INTEGER,

  -- Data quality
  opportunities_with_coverage INTEGER DEFAULT 0,
  opportunities_without_coverage INTEGER DEFAULT 0,
  opportunities_with_contract_id INTEGER DEFAULT 0,
  opportunities_missing_ndc INTEGER DEFAULT 0,

  -- Workability distribution
  grade_a_count INTEGER DEFAULT 0,
  grade_b_count INTEGER DEFAULT 0,
  grade_c_count INTEGER DEFAULT 0,
  grade_d_count INTEGER DEFAULT 0,
  grade_f_count INTEGER DEFAULT 0,
  avg_workability_score NUMERIC(5,2),

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT uq_coverage_metrics UNIQUE (pharmacy_id, metric_date)
);

CREATE INDEX IF NOT EXISTS idx_coverage_metrics_date ON coverage_intelligence_metrics(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_coverage_metrics_pharmacy ON coverage_intelligence_metrics(pharmacy_id);


-- ===========================================
-- ADD WORKABILITY TO OPPORTUNITIES
-- ===========================================
ALTER TABLE opportunities
  ADD COLUMN IF NOT EXISTS workability_score INTEGER,
  ADD COLUMN IF NOT EXISTS workability_grade VARCHAR(1),
  ADD COLUMN IF NOT EXISTS coverage_verified BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS coverage_source VARCHAR(50),
  ADD COLUMN IF NOT EXISTS last_coverage_check TIMESTAMPTZ;


-- ===========================================
-- HELPER FUNCTIONS
-- ===========================================

-- Calculate workability grade from score
CREATE OR REPLACE FUNCTION calculate_workability_grade(score INTEGER)
RETURNS VARCHAR(1)
LANGUAGE plpgsql
AS $$
BEGIN
  IF score >= 80 THEN RETURN 'A';
  ELSIF score >= 60 THEN RETURN 'B';
  ELSIF score >= 40 THEN RETURN 'C';
  ELSIF score >= 20 THEN RETURN 'D';
  ELSE RETURN 'F';
  END IF;
END;
$$;


-- Get coverage verification success rate
CREATE OR REPLACE FUNCTION get_coverage_success_rate(
  p_pharmacy_id UUID DEFAULT NULL,
  p_days_back INTEGER DEFAULT 7
)
RETURNS TABLE (
  total_checks BIGINT,
  successful_checks BIGINT,
  success_rate NUMERIC,
  covered_rate NUMERIC,
  avg_response_ms NUMERIC
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT as total_checks,
    COUNT(*) FILTER (WHERE verification_success = true)::BIGINT as successful_checks,
    ROUND(100.0 * COUNT(*) FILTER (WHERE verification_success = true) / NULLIF(COUNT(*), 0), 2) as success_rate,
    ROUND(100.0 * COUNT(*) FILTER (WHERE is_covered = true) / NULLIF(COUNT(*) FILTER (WHERE verification_success = true), 0), 2) as covered_rate,
    ROUND(AVG(response_time_ms)::NUMERIC, 2) as avg_response_ms
  FROM coverage_verification_log
  WHERE created_at >= NOW() - (p_days_back || ' days')::INTERVAL
    AND (p_pharmacy_id IS NULL OR pharmacy_id = p_pharmacy_id);
END;
$$;


-- Get workability distribution
CREATE OR REPLACE FUNCTION get_workability_distribution(p_pharmacy_id UUID DEFAULT NULL)
RETURNS TABLE (
  grade VARCHAR(1),
  count BIGINT,
  avg_score NUMERIC,
  pct_of_total NUMERIC
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH grades AS (
    SELECT
      ow.workability_grade,
      COUNT(*) as cnt,
      AVG(ow.workability_score) as avg_scr
    FROM opportunity_workability ow
    JOIN opportunities o ON o.opportunity_id = ow.opportunity_id
    WHERE o.status = 'Not Submitted'
      AND (p_pharmacy_id IS NULL OR o.pharmacy_id = p_pharmacy_id)
    GROUP BY ow.workability_grade
  ),
  total AS (
    SELECT SUM(cnt) as total_cnt FROM grades
  )
  SELECT
    g.workability_grade as grade,
    g.cnt as count,
    ROUND(g.avg_scr::NUMERIC, 1) as avg_score,
    ROUND(100.0 * g.cnt / NULLIF(t.total_cnt, 0), 1) as pct_of_total
  FROM grades g, total t
  ORDER BY g.workability_grade;
END;
$$;


-- ===========================================
-- VIEWS
-- ===========================================

-- Opportunities with workability info
CREATE OR REPLACE VIEW v_opportunities_workability AS
SELECT
  o.*,
  ow.workability_score,
  ow.workability_grade,
  ow.coverage_score,
  ow.margin_score,
  ow.patient_score,
  ow.prescriber_score,
  ow.data_quality_score,
  ow.issues,
  ow.missing_data,
  ow.blockers,
  ow.next_action,
  ow.scored_at
FROM opportunities o
LEFT JOIN opportunity_workability ow ON ow.opportunity_id = o.opportunity_id;


-- Coverage verification summary by pharmacy
CREATE OR REPLACE VIEW v_coverage_summary AS
SELECT
  p.pharmacy_id,
  p.pharmacy_name,
  COUNT(DISTINCT o.opportunity_id) as total_opportunities,
  COUNT(DISTINCT o.opportunity_id) FILTER (WHERE o.coverage_verified = true) as verified_count,
  COUNT(DISTINCT o.opportunity_id) FILTER (WHERE o.medicare_covered = true) as covered_count,
  COUNT(DISTINCT o.opportunity_id) FILTER (WHERE o.medicare_covered = false) as not_covered_count,
  ROUND(100.0 * COUNT(DISTINCT o.opportunity_id) FILTER (WHERE o.coverage_verified = true) /
    NULLIF(COUNT(DISTINCT o.opportunity_id), 0), 1) as verification_rate,
  ROUND(AVG(ow.workability_score)::NUMERIC, 1) as avg_workability
FROM pharmacies p
LEFT JOIN opportunities o ON o.pharmacy_id = p.pharmacy_id AND o.status = 'Not Submitted'
LEFT JOIN opportunity_workability ow ON ow.opportunity_id = o.opportunity_id
GROUP BY p.pharmacy_id, p.pharmacy_name;


-- ===========================================
-- GRANTS
-- ===========================================
GRANT ALL ON formulary_items TO authenticated;
GRANT ALL ON insurance_contracts TO authenticated;
GRANT ALL ON coverage_verification_log TO authenticated;
GRANT ALL ON opportunity_workability TO authenticated;
GRANT ALL ON cms_plan_reference TO authenticated;
GRANT ALL ON coverage_intelligence_metrics TO authenticated;
GRANT EXECUTE ON FUNCTION calculate_workability_grade TO authenticated;
GRANT EXECUTE ON FUNCTION get_coverage_success_rate TO authenticated;
GRANT EXECUTE ON FUNCTION get_workability_distribution TO authenticated;


-- Success message
DO $$ BEGIN RAISE NOTICE 'Coverage intelligence tables created successfully!'; END $$;
