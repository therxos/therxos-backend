-- Migration: 002_trigger_management.sql
-- Trigger Management System for TheRxOS V2
-- Run this in Supabase SQL Editor

-- ===========================================
-- TRIGGERS TABLE - Core trigger definitions
-- ===========================================
CREATE TABLE IF NOT EXISTS triggers (
  trigger_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification
  trigger_code VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255) NOT NULL,

  -- Classification
  trigger_type VARCHAR(50) NOT NULL CHECK (trigger_type IN (
    'therapeutic_interchange',
    'missing_therapy',
    'ndc_optimization'
  )),
  category VARCHAR(100),

  -- Detection Logic
  detection_keywords TEXT[],
  exclude_keywords TEXT[],
  if_has_keywords TEXT[],
  if_not_has_keywords TEXT[],

  -- Recommended Therapy
  recommended_drug VARCHAR(255),
  recommended_ndc VARCHAR(20),

  -- Action & Rationale
  action_instructions TEXT,
  clinical_rationale TEXT,

  -- Settings
  priority VARCHAR(20) DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  annual_fills INTEGER DEFAULT 12,
  default_gp_value NUMERIC,

  -- Status
  is_enabled BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_triggers_type ON triggers(trigger_type);
CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers(is_enabled);
CREATE INDEX IF NOT EXISTS idx_triggers_code ON triggers(trigger_code);


-- ===========================================
-- TRIGGER BIN VALUES - BIN-specific GP values
-- ===========================================
CREATE TABLE IF NOT EXISTS trigger_bin_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id UUID NOT NULL REFERENCES triggers(trigger_id) ON DELETE CASCADE,

  -- BIN specification
  insurance_bin VARCHAR(20) NOT NULL,

  -- GP value (NULL means use default, is_excluded=true means skip this BIN)
  gp_value NUMERIC,
  is_excluded BOOLEAN DEFAULT false,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Unique constraint: one entry per trigger+BIN
  UNIQUE(trigger_id, insurance_bin)
);

CREATE INDEX IF NOT EXISTS idx_trigger_bin_values_trigger ON trigger_bin_values(trigger_id);
CREATE INDEX IF NOT EXISTS idx_trigger_bin_values_bin ON trigger_bin_values(insurance_bin);


-- ===========================================
-- TRIGGER RESTRICTIONS - BIN/Group restrictions
-- ===========================================
CREATE TABLE IF NOT EXISTS trigger_restrictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id UUID NOT NULL REFERENCES triggers(trigger_id) ON DELETE CASCADE,

  -- Restriction type
  restriction_type VARCHAR(20) NOT NULL CHECK (restriction_type IN (
    'bin_only',
    'bin_exclude',
    'group_only',
    'group_exclude'
  )),

  -- Values
  insurance_bin VARCHAR(20),
  insurance_groups TEXT[],

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trigger_restrictions_trigger ON trigger_restrictions(trigger_id);


-- ===========================================
-- AUDIT RULES - Compliance/audit risk detection
-- ===========================================
CREATE TABLE IF NOT EXISTS audit_rules (
  rule_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification
  rule_code VARCHAR(100) UNIQUE NOT NULL,
  rule_name VARCHAR(255) NOT NULL,
  rule_description TEXT,

  -- Rule type
  rule_type VARCHAR(50) NOT NULL CHECK (rule_type IN (
    'quantity_mismatch',
    'days_supply_mismatch',
    'daw_violation',
    'sig_quantity_mismatch',
    'high_gp_risk'
  )),

  -- Drug targeting (NULL = applies to all drugs)
  drug_keywords TEXT[],
  ndc_pattern VARCHAR(50),

  -- Quantity rules
  expected_quantity NUMERIC,
  min_quantity NUMERIC,
  max_quantity NUMERIC,
  quantity_tolerance NUMERIC DEFAULT 0.1,

  -- Days supply rules
  min_days_supply INTEGER,
  max_days_supply INTEGER,

  -- DAW rules
  allowed_daw_codes TEXT[],
  has_generic_available BOOLEAN,

  -- GP threshold (for high_gp_risk type)
  gp_threshold NUMERIC DEFAULT 50,

  -- Severity & Risk
  severity VARCHAR(20) DEFAULT 'warning' CHECK (severity IN ('critical', 'warning', 'info')),
  audit_risk_score INTEGER CHECK (audit_risk_score >= 1 AND audit_risk_score <= 10),

  -- Status
  is_enabled BOOLEAN DEFAULT true,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_rules_type ON audit_rules(rule_type);
CREATE INDEX IF NOT EXISTS idx_audit_rules_enabled ON audit_rules(is_enabled);


-- ===========================================
-- AUDIT FLAGS - Detected audit risks per claim
-- ===========================================
CREATE TABLE IF NOT EXISTS audit_flags (
  flag_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- References
  pharmacy_id UUID REFERENCES pharmacies(pharmacy_id),
  patient_id UUID REFERENCES patients(patient_id),
  prescription_id UUID,
  rule_id UUID REFERENCES audit_rules(rule_id),

  -- Flag details
  rule_type VARCHAR(50) NOT NULL,
  severity VARCHAR(20) NOT NULL,

  -- What was found
  drug_name VARCHAR(255),
  ndc VARCHAR(20),
  dispensed_quantity NUMERIC,
  days_supply INTEGER,
  daw_code VARCHAR(10),
  sig TEXT,
  gross_profit NUMERIC,

  -- Violation details
  violation_message TEXT NOT NULL,
  expected_value TEXT,
  actual_value TEXT,

  -- Status
  status VARCHAR(50) DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved', 'false_positive')),
  reviewed_by UUID REFERENCES users(user_id),
  reviewed_at TIMESTAMPTZ,
  resolution_notes TEXT,

  -- Timestamps
  flagged_at TIMESTAMPTZ DEFAULT NOW(),
  dispensed_date DATE
);

CREATE INDEX IF NOT EXISTS idx_audit_flags_pharmacy ON audit_flags(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_audit_flags_status ON audit_flags(status);
CREATE INDEX IF NOT EXISTS idx_audit_flags_severity ON audit_flags(severity);
CREATE INDEX IF NOT EXISTS idx_audit_flags_date ON audit_flags(dispensed_date DESC);


-- ===========================================
-- INSERT DEFAULT AUDIT RULES
-- ===========================================

-- Ozempic quantity rule
INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, expected_quantity, min_days_supply, max_days_supply, has_generic_available, severity, audit_risk_score)
VALUES (
  'OZEMPIC_QTY',
  'Ozempic Quantity Check',
  'Ozempic must be dispensed as 3ml. Any other quantity is incorrect and subject to audit.',
  'quantity_mismatch',
  ARRAY['OZEMPIC', 'SEMAGLUTIDE'],
  3,
  28,
  30,
  false,
  'critical',
  9
) ON CONFLICT (rule_code) DO NOTHING;

-- Synthroid DAW rule
INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, allowed_daw_codes, has_generic_available, severity, audit_risk_score)
VALUES (
  'SYNTHROID_DAW',
  'Synthroid DAW Code Check',
  'Synthroid has generic available. Must have DAW 1, 2, or 9 - not DAW 0.',
  'daw_violation',
  ARRAY['SYNTHROID'],
  ARRAY['1', '2', '9'],
  true,
  'critical',
  8
) ON CONFLICT (rule_code) DO NOTHING;

-- General high GP risk
INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, gp_threshold, severity, audit_risk_score)
VALUES (
  'HIGH_GP_RISK',
  'High Gross Profit Risk',
  'Claims with gross profit over $50 attract PBM audit scrutiny.',
  'high_gp_risk',
  50,
  'warning',
  6
) ON CONFLICT (rule_code) DO NOTHING;

-- SIG/Quantity mismatch for daily meds
INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, quantity_tolerance, severity, audit_risk_score)
VALUES (
  'SIG_QTY_DAILY',
  'SIG/Quantity Mismatch - Daily Meds',
  'For medications taken once daily, quantity should equal days supply (within 10% tolerance).',
  'sig_quantity_mismatch',
  0.1,
  'warning',
  5
) ON CONFLICT (rule_code) DO NOTHING;


-- ===========================================
-- GRANT PERMISSIONS
-- ===========================================
GRANT ALL ON triggers TO authenticated;
GRANT ALL ON trigger_bin_values TO authenticated;
GRANT ALL ON trigger_restrictions TO authenticated;
GRANT ALL ON audit_rules TO authenticated;
GRANT ALL ON audit_flags TO authenticated;


-- Success message
DO $$ BEGIN RAISE NOTICE 'Trigger management tables created successfully!'; END $$;
