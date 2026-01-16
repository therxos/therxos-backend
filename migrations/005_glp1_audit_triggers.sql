-- Migration: 005_glp1_audit_triggers.sql
-- GLP-1 Dispensing Audit Triggers for TheRxOS V2
-- Based on analysis of 3,459 GLP-1 prescriptions finding 1,097 anomalies
-- Run this in Supabase SQL Editor

-- ===========================================
-- EXTEND AUDIT RULES RULE_TYPE
-- Add new rule types for GLP-1 specific audits
-- ===========================================

-- Drop and recreate the constraint to add new rule types
ALTER TABLE audit_rules DROP CONSTRAINT IF EXISTS audit_rules_rule_type_check;
ALTER TABLE audit_rules ADD CONSTRAINT audit_rules_rule_type_check
CHECK (rule_type IN (
  -- Existing types
  'quantity_mismatch',
  'days_supply_mismatch',
  'daw_violation',
  'sig_quantity_mismatch',
  'high_gp_risk',
  -- New GLP-1 specific types
  'early_refill',
  'duplicate_therapy',
  'compounding_risk',
  'negative_profit',
  'indication_mismatch',
  'high_quantity'
));


-- ===========================================
-- GLP-1 QUANTITY VALIDATION
-- Flags GLP-1 claims with unexpected package quantities
-- Found 456 anomalies in data analysis
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  expected_quantity,
  min_quantity,
  max_quantity,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_TRULICITY_QTY',
  'Trulicity Quantity Validation',
  'Trulicity is dispensed as 4 pens per box for 28-day supply. Quantity of 2 pens may indicate partial fill or billing error. Most common anomaly found in data (456 instances).',
  'quantity_mismatch',
  ARRAY['TRULICITY', 'DULAGLUTIDE'],
  4,
  4,
  8,
  'warning',
  6
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  expected_quantity = EXCLUDED.expected_quantity,
  min_quantity = EXCLUDED.min_quantity,
  max_quantity = EXCLUDED.max_quantity,
  updated_at = NOW();

INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  expected_quantity,
  min_quantity,
  max_quantity,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_MOUNJARO_QTY',
  'Mounjaro Quantity Validation',
  'Mounjaro is dispensed as 4 pens per box for 28-day supply. Verify quantity matches package size.',
  'quantity_mismatch',
  ARRAY['MOUNJARO', 'TIRZEPATIDE', 'ZEPBOUND'],
  4,
  2,
  8,
  'warning',
  6
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- GLP-1 DAYS SUPPLY VALIDATION
-- Flags unusual days supply (found 32 anomalies)
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  min_days_supply,
  max_days_supply,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_DAYS_SUPPLY',
  'GLP-1 Days Supply Validation',
  'GLP-1 injectables typically dispensed as 28 or 30 day supply. Days supply of 42 or 56 may indicate titration packs or billing adjustments. Found 32 instances with unusual days supply.',
  'days_supply_mismatch',
  ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE'],
  21,
  35,
  'info',
  4
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- GLP-1 EARLY REFILL DETECTION
-- Found 66 instances of refills 8-20 days early
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  min_days_supply,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_EARLY_REFILL',
  'GLP-1 Early Refill Alert',
  'Detects GLP-1 refills more than 7 days before expected based on previous fill date and days supply. Early refills may indicate stockpiling, diversion risk, or dosing issues. Found 66 instances.',
  'early_refill',
  ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE', 'EXENATIDE'],
  7, -- Days early threshold
  'warning',
  7
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- GLP-1 NEGATIVE MARGIN ALERT
-- Found 233 claims with negative gross profit
-- Major reimbursement issue requiring attention
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  gp_threshold,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_NEGATIVE_MARGIN',
  'GLP-1 Negative Margin Alert',
  'GLP-1 claims with negative gross profit (losing $900-1000+ per fill). Found 233 instances. BINs affected: 004740, 610097, 004336, 610502, 610014. Review contract pricing and acquisition costs immediately.',
  'negative_profit',
  ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE'],
  0, -- Threshold: less than $0
  'critical',
  9
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- GLP-1 HIGH QUANTITY ALERT
-- Found 258 claims with qty > 10 (likely compounded)
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  max_quantity,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_HIGH_QUANTITY',
  'GLP-1 High Quantity Alert',
  'GLP-1 claims with quantity > 10 units. May indicate compounded products (e.g., "Tirzepatide 15mg/0.3ml: Qty 20-40") or data entry errors. Found 258 instances. FDA has warned about compounded semaglutide/tirzepatide products.',
  'high_quantity',
  ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'SEMAGLUTIDE', 'TIRZEPATIDE'],
  10,
  'critical',
  9
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  max_quantity = EXCLUDED.max_quantity,
  updated_at = NOW();


-- ===========================================
-- GLP-1 DUPLICATE THERAPY ALERT
-- Found 3 patients on multiple GLP-1 classes
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_DUPLICATE_THERAPY',
  'Duplicate GLP-1 Therapy Alert',
  'Patient receiving multiple GLP-1 medications from different classes simultaneously (e.g., Ozempic + Mounjaro). Found 3 patients. This may be clinically inappropriate and increases hypoglycemia risk. Example: PEDRO DEOLEO on both MOUNJARO and OZEMPIC.',
  'duplicate_therapy',
  ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS', 'BYETTA', 'BYDUREON', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE', 'EXENATIDE'],
  'critical',
  9
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- GLP-1 INDICATION MISMATCH
-- Patient on both weight loss AND diabetes GLP-1
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_INDICATION_MISMATCH',
  'GLP-1 Indication Mismatch',
  'Patient receiving both weight loss (Wegovy, Zepbound) and diabetes (Ozempic, Mounjaro) GLP-1 formulations. Same active ingredient but different indications and pricing. Found patients like SEBRINA LAING on both MOUNJARO and WEGOVY. Review for appropriate therapy selection.',
  'indication_mismatch',
  ARRAY['WEGOVY', 'ZEPBOUND', 'SAXENDA', 'OZEMPIC', 'MOUNJARO', 'TRULICITY', 'VICTOZA'],
  'warning',
  7
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- GLP-1 DAW CODE VALIDATION
-- Found 43 claims with DAW 1 on brand-only drugs
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  allowed_daw_codes,
  has_generic_available,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_DAW_CODE',
  'GLP-1 DAW Code Check',
  'GLP-1 medications (Ozempic, Wegovy, Mounjaro, Zepbound) have no generic available. DAW code 1 (Brand Requested) is unnecessary and may cause claim processing issues. Found 43 instances.',
  'daw_violation',
  ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA'],
  ARRAY['0'],  -- Only DAW 0 should be used (generics not available)
  false,
  'info',
  3
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- GLP-1 COMPOUNDING RISK ALERT
-- FDA has issued warnings about compounded products
-- ===========================================
INSERT INTO audit_rules (
  rule_code,
  rule_name,
  rule_description,
  rule_type,
  drug_keywords,
  severity,
  audit_risk_score
)
VALUES (
  'GLP1_COMPOUNDING_RISK',
  'GLP-1 Compounding Risk Alert',
  'Flags potential compounded GLP-1 products based on drug name containing "COMPOUND", missing/invalid NDC, or unusual formulations. FDA has issued multiple warnings about safety risks of compounded semaglutide and tirzepatide products. Verify source and regulatory compliance.',
  'compounding_risk',
  ARRAY['SEMAGLUTIDE COMPOUND', 'TIRZEPATIDE COMPOUND', 'COMPOUNDED SEMAGLUTIDE', 'COMPOUNDED TIRZEPATIDE', 'COMPOUNDED GLP-1'],
  'critical',
  10
) ON CONFLICT (rule_code) DO UPDATE SET
  rule_description = EXCLUDED.rule_description,
  updated_at = NOW();


-- ===========================================
-- CREATE VIEW FOR GLP-1 AUDIT SUMMARY
-- ===========================================
CREATE OR REPLACE VIEW v_glp1_audit_summary AS
SELECT
  ar.rule_code,
  ar.rule_name,
  ar.severity,
  ar.audit_risk_score,
  COUNT(af.flag_id) as flag_count,
  COUNT(CASE WHEN af.status = 'open' THEN 1 END) as open_count,
  COUNT(CASE WHEN af.status = 'reviewed' THEN 1 END) as reviewed_count,
  COUNT(CASE WHEN af.status = 'resolved' THEN 1 END) as resolved_count,
  COUNT(CASE WHEN af.status = 'false_positive' THEN 1 END) as false_positive_count
FROM audit_rules ar
LEFT JOIN audit_flags af ON ar.rule_id = af.rule_id
WHERE ar.rule_code LIKE 'GLP1_%' OR ar.rule_code = 'OZEMPIC_QTY'
GROUP BY ar.rule_id, ar.rule_code, ar.rule_name, ar.severity, ar.audit_risk_score
ORDER BY ar.audit_risk_score DESC;


-- ===========================================
-- CREATE VIEW FOR GLP-1 NEGATIVE MARGIN CLAIMS
-- Quick access to money-losing GLP-1 fills
-- ===========================================
CREATE OR REPLACE VIEW v_glp1_negative_margin_claims AS
SELECT
  p.prescription_id,
  p.pharmacy_id,
  p.patient_id,
  p.drug_name,
  p.ndc,
  p.quantity_dispensed,
  p.days_supply,
  p.dispensed_date,
  p.insurance_bin,
  p.insurance_group,
  (COALESCE(p.patient_pay, 0) + COALESCE(p.insurance_pay, 0) - COALESCE(p.acquisition_cost, 0)) as gross_profit,
  p.acquisition_cost,
  p.insurance_pay,
  p.patient_pay
FROM prescriptions p
WHERE p.drug_name ~* 'OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE'
  AND (COALESCE(p.patient_pay, 0) + COALESCE(p.insurance_pay, 0) - COALESCE(p.acquisition_cost, 0)) < 0
ORDER BY gross_profit ASC;


-- ===========================================
-- CREATE FUNCTION TO CHECK GLP-1 EARLY REFILLS
-- ===========================================
CREATE OR REPLACE FUNCTION check_glp1_early_refill(
  p_patient_id UUID,
  p_drug_name TEXT,
  p_dispensed_date DATE
)
RETURNS TABLE (
  is_early_refill BOOLEAN,
  days_early INTEGER,
  prev_fill_date DATE,
  prev_days_supply INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  glp1_class TEXT;
BEGIN
  -- Normalize to GLP-1 class
  glp1_class := CASE
    WHEN p_drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS|SEMAGLUTIDE' THEN 'SEMAGLUTIDE'
    WHEN p_drug_name ~* 'MOUNJARO|ZEPBOUND|TIRZEPATIDE' THEN 'TIRZEPATIDE'
    WHEN p_drug_name ~* 'VICTOZA|SAXENDA|LIRAGLUTIDE' THEN 'LIRAGLUTIDE'
    WHEN p_drug_name ~* 'TRULICITY|DULAGLUTIDE' THEN 'DULAGLUTIDE'
    WHEN p_drug_name ~* 'BYETTA|BYDUREON|EXENATIDE' THEN 'EXENATIDE'
    ELSE NULL
  END;

  IF glp1_class IS NULL THEN
    RETURN QUERY SELECT FALSE, 0, NULL::DATE, NULL::INTEGER;
    RETURN;
  END IF;

  RETURN QUERY
  WITH prev_fill AS (
    SELECT
      pr.dispensed_date as pf_date,
      pr.days_supply as pf_days
    FROM prescriptions pr
    WHERE pr.patient_id = p_patient_id
      AND pr.drug_name ~* glp1_class
      AND pr.dispensed_date < p_dispensed_date
    ORDER BY pr.dispensed_date DESC
    LIMIT 1
  )
  SELECT
    CASE
      WHEN pf.pf_date IS NOT NULL
           AND (p_dispensed_date - pf.pf_date) < (pf.pf_days - 7)
      THEN TRUE
      ELSE FALSE
    END as is_early,
    CASE
      WHEN pf.pf_date IS NOT NULL
      THEN pf.pf_days - (p_dispensed_date - pf.pf_date)::INTEGER
      ELSE 0
    END as days_early,
    pf.pf_date,
    pf.pf_days
  FROM prev_fill pf;
END;
$$;


-- ===========================================
-- CREATE FUNCTION TO CHECK DUPLICATE GLP-1 THERAPY
-- ===========================================
CREATE OR REPLACE FUNCTION check_duplicate_glp1_therapy(
  p_patient_id UUID,
  p_lookback_days INTEGER DEFAULT 90
)
RETURNS TABLE (
  has_duplicate BOOLEAN,
  glp1_classes TEXT[],
  drug_names TEXT[]
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH patient_glp1 AS (
    SELECT DISTINCT
      CASE
        WHEN drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS' THEN 'SEMAGLUTIDE'
        WHEN drug_name ~* 'MOUNJARO|ZEPBOUND' THEN 'TIRZEPATIDE'
        WHEN drug_name ~* 'VICTOZA|SAXENDA' THEN 'LIRAGLUTIDE'
        WHEN drug_name ~* 'TRULICITY' THEN 'DULAGLUTIDE'
        WHEN drug_name ~* 'BYETTA|BYDUREON' THEN 'EXENATIDE'
        ELSE 'OTHER'
      END as glp1_class,
      drug_name
    FROM prescriptions
    WHERE patient_id = p_patient_id
      AND drug_name ~* 'OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|BYETTA|BYDUREON|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE|EXENATIDE'
      AND dispensed_date >= CURRENT_DATE - (p_lookback_days || ' days')::INTERVAL
  )
  SELECT
    (COUNT(DISTINCT glp1_class) > 1) as has_dup,
    ARRAY_AGG(DISTINCT glp1_class) as classes,
    ARRAY_AGG(DISTINCT drug_name) as drugs
  FROM patient_glp1;
END;
$$;


-- ===========================================
-- SUMMARY OF GLP-1 AUDIT TRIGGERS ADDED
-- ===========================================
/*
Based on analysis of 3,459 GLP-1 prescriptions, we found 1,097 anomalies:

| Trigger Code              | Severity  | Risk | Anomalies Found | Description |
|---------------------------|-----------|------|-----------------|-------------|
| GLP1_TRULICITY_QTY        | WARNING   | 6    | 456             | Qty 2 instead of 4 pens |
| GLP1_MOUNJARO_QTY         | WARNING   | 6    | -               | Package size validation |
| GLP1_DAYS_SUPPLY          | INFO      | 4    | 32              | 42/56 day supply flags |
| GLP1_EARLY_REFILL         | WARNING   | 7    | 66              | Refills 8-20 days early |
| GLP1_NEGATIVE_MARGIN      | CRITICAL  | 9    | 233             | $900-1000+ losses per fill |
| GLP1_HIGH_QUANTITY        | CRITICAL  | 9    | 258             | Qty >10 (compounded?) |
| GLP1_DUPLICATE_THERAPY    | CRITICAL  | 9    | 3               | Multiple GLP-1 classes |
| GLP1_INDICATION_MISMATCH  | WARNING   | 7    | (subset of 3)   | Wegovy + Ozempic |
| GLP1_DAW_CODE             | INFO      | 3    | 43              | DAW 1 on brand-only |
| GLP1_COMPOUNDING_RISK     | CRITICAL  | 10   | 0               | FDA warning compliance |

BINs with highest negative margin claims:
- 004740 (Ozempic -$972.64)
- 610097 (Trulicity -$962.51, Ozempic -$972.64, Mounjaro -$1052.78)
- 004336 (Mounjaro -$1052.78, Trulicity -$962.51)
- 610502 (Trulicity -$962.51, Ozempic -$972.64)
- 610014 (Mounjaro -$1052.78)

Patients flagged for duplicate therapy:
1. PEDRO DEOLEO: MOUNJARO 5MG + OZEMPIC 1MG
2. SEBRINA LAING: MOUNJARO 5MG + WEGOVY 2.4MG
3. SHLOMO MARMORSTEIN: MOUNJARO 10MG + OZEMPIC 2MG
*/

-- Success message
DO $$ BEGIN RAISE NOTICE 'GLP-1 audit triggers created successfully! 10 new rules added.'; END $$;
