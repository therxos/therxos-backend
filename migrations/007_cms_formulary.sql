-- CMS Medicare Part D Formulary Tables
-- Optimized for fast coverage lookups

-- Plan information table - maps CONTRACT_ID + PLAN_ID to FORMULARY_ID
CREATE TABLE IF NOT EXISTS cms_plan_formulary (
  id SERIAL PRIMARY KEY,
  contract_id VARCHAR(10) NOT NULL,
  plan_id VARCHAR(3) NOT NULL,
  segment_id VARCHAR(3),
  contract_name VARCHAR(255),
  plan_name VARCHAR(255),
  formulary_id VARCHAR(20) NOT NULL,
  premium NUMERIC(10,2),
  deductible NUMERIC(10,2),
  ma_region_code VARCHAR(10),
  pdp_region_code VARCHAR(10),
  state VARCHAR(2),
  county_code VARCHAR(10),
  snp VARCHAR(1),
  plan_suppressed VARCHAR(1),
  data_year INTEGER DEFAULT 2026,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint for lookups
  CONSTRAINT uq_cms_plan_formulary UNIQUE (contract_id, plan_id, formulary_id, county_code)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_cms_plan_contract_plan ON cms_plan_formulary(contract_id, plan_id);
CREATE INDEX IF NOT EXISTS idx_cms_plan_formulary_id ON cms_plan_formulary(formulary_id);
CREATE INDEX IF NOT EXISTS idx_cms_plan_state ON cms_plan_formulary(state);

-- Formulary drug coverage table - the main lookup table
CREATE TABLE IF NOT EXISTS cms_formulary_drugs (
  id SERIAL PRIMARY KEY,
  formulary_id VARCHAR(20) NOT NULL,
  formulary_version INTEGER,
  contract_year INTEGER,
  rxcui VARCHAR(20),
  ndc VARCHAR(11) NOT NULL,
  tier_level INTEGER,
  quantity_limit_yn BOOLEAN DEFAULT FALSE,
  quantity_limit_amount NUMERIC(10,2),
  quantity_limit_days INTEGER,
  prior_authorization_yn BOOLEAN DEFAULT FALSE,
  step_therapy_yn BOOLEAN DEFAULT FALSE,
  data_year INTEGER DEFAULT 2026,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint
  CONSTRAINT uq_cms_formulary_drug UNIQUE (formulary_id, ndc)
);

-- Critical indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_cms_formulary_ndc ON cms_formulary_drugs(ndc);
CREATE INDEX IF NOT EXISTS idx_cms_formulary_lookup ON cms_formulary_drugs(formulary_id, ndc);
CREATE INDEX IF NOT EXISTS idx_cms_formulary_rxcui ON cms_formulary_drugs(rxcui);
CREATE INDEX IF NOT EXISTS idx_cms_formulary_tier ON cms_formulary_drugs(tier_level);

-- Composite index for the most common query pattern
CREATE INDEX IF NOT EXISTS idx_cms_formulary_full ON cms_formulary_drugs(formulary_id, ndc, tier_level, prior_authorization_yn, step_therapy_yn);

-- View for easy lookups: CONTRACT_ID + PLAN_ID + NDC -> Coverage
CREATE OR REPLACE VIEW cms_coverage_lookup AS
SELECT DISTINCT ON (p.contract_id, p.plan_id, f.ndc)
  p.contract_id,
  p.plan_id,
  p.plan_name,
  p.formulary_id,
  f.ndc,
  f.rxcui,
  f.tier_level,
  f.prior_authorization_yn,
  f.step_therapy_yn,
  f.quantity_limit_yn,
  f.quantity_limit_amount,
  f.quantity_limit_days,
  CASE f.tier_level
    WHEN 1 THEN 'Preferred Generic'
    WHEN 2 THEN 'Generic'
    WHEN 3 THEN 'Preferred Brand'
    WHEN 4 THEN 'Non-Preferred Brand'
    WHEN 5 THEN 'Specialty'
    WHEN 6 THEN 'Specialty (High Cost)'
    ELSE 'Tier ' || f.tier_level
  END as tier_description
FROM cms_plan_formulary p
JOIN cms_formulary_drugs f ON f.formulary_id = p.formulary_id;

-- Function for quick coverage check
CREATE OR REPLACE FUNCTION check_cms_coverage(
  p_contract_id VARCHAR,
  p_plan_id VARCHAR,
  p_ndc VARCHAR
) RETURNS TABLE (
  covered BOOLEAN,
  tier_level INTEGER,
  tier_description TEXT,
  prior_auth BOOLEAN,
  step_therapy BOOLEAN,
  quantity_limit BOOLEAN,
  quantity_limit_amount NUMERIC,
  quantity_limit_days INTEGER,
  plan_name VARCHAR
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    TRUE as covered,
    f.tier_level,
    CASE f.tier_level
      WHEN 1 THEN 'Preferred Generic'
      WHEN 2 THEN 'Generic'
      WHEN 3 THEN 'Preferred Brand'
      WHEN 4 THEN 'Non-Preferred Brand'
      WHEN 5 THEN 'Specialty'
      WHEN 6 THEN 'Specialty (High Cost)'
      ELSE 'Tier ' || f.tier_level
    END::TEXT as tier_description,
    f.prior_authorization_yn,
    f.step_therapy_yn,
    f.quantity_limit_yn,
    f.quantity_limit_amount,
    f.quantity_limit_days,
    p.plan_name
  FROM cms_plan_formulary p
  JOIN cms_formulary_drugs f ON f.formulary_id = p.formulary_id
  WHERE p.contract_id = p_contract_id
    AND p.plan_id = LPAD(p_plan_id, 3, '0')
    AND f.ndc = LPAD(REPLACE(p_ndc, '-', ''), 11, '0')
  LIMIT 1;

  -- If no rows returned, drug is not covered
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      FALSE as covered,
      NULL::INTEGER as tier_level,
      'Not on formulary'::TEXT as tier_description,
      FALSE as prior_auth,
      FALSE as step_therapy,
      FALSE as quantity_limit,
      NULL::NUMERIC as quantity_limit_amount,
      NULL::INTEGER as quantity_limit_days,
      NULL::VARCHAR as plan_name;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Add indexes to opportunities table for coverage columns if not exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_opportunities_medicare_covered') THEN
    CREATE INDEX idx_opportunities_medicare_covered ON opportunities(medicare_covered);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_opportunities_medicare_tier') THEN
    CREATE INDEX idx_opportunities_medicare_tier ON opportunities(medicare_tier);
  END IF;
END $$;

-- Add coverage_verified column if not exists
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'opportunities' AND column_name = 'coverage_verified') THEN
    ALTER TABLE opportunities ADD COLUMN coverage_verified BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'opportunities' AND column_name = 'coverage_source') THEN
    ALTER TABLE opportunities ADD COLUMN coverage_source VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'opportunities' AND column_name = 'last_coverage_check') THEN
    ALTER TABLE opportunities ADD COLUMN last_coverage_check TIMESTAMPTZ;
  END IF;
END $$;
