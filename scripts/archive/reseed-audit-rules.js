import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // Re-seed audit_rules from migrations 002 and 005
  const sql = `
    -- From migration 002
    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, expected_quantity, min_days_supply, max_days_supply, has_generic_available, severity, audit_risk_score)
    VALUES ('OZEMPIC_QTY', 'Ozempic Quantity Check', 'Ozempic must be dispensed as 3ml. Any other quantity is incorrect and subject to audit.', 'quantity_mismatch', ARRAY['OZEMPIC', 'SEMAGLUTIDE'], 3, 28, 30, false, 'critical', 9)
    ON CONFLICT (rule_code) DO NOTHING;

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, allowed_daw_codes, has_generic_available, severity, audit_risk_score)
    VALUES ('SYNTHROID_DAW', 'Synthroid DAW Code Check', 'Synthroid has generic available. Must have DAW 1, 2, or 9 - not DAW 0.', 'daw_violation', ARRAY['SYNTHROID'], ARRAY['1', '2', '9'], true, 'critical', 8)
    ON CONFLICT (rule_code) DO NOTHING;

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, gp_threshold, severity, audit_risk_score)
    VALUES ('HIGH_GP_RISK', 'High Gross Profit Risk', 'Claims with gross profit over $50 attract PBM audit scrutiny.', 'high_gp_risk', 50, 'warning', 6)
    ON CONFLICT (rule_code) DO NOTHING;

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, quantity_tolerance, severity, audit_risk_score)
    VALUES ('SIG_QTY_DAILY', 'SIG/Quantity Mismatch - Daily Meds', 'For medications taken once daily, quantity should equal days supply (within 10% tolerance).', 'sig_quantity_mismatch', 0.1, 'warning', 5)
    ON CONFLICT (rule_code) DO NOTHING;

    -- From migration 005 (GLP-1 rules)
    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, expected_quantity, min_quantity, max_quantity, severity, audit_risk_score)
    VALUES ('GLP1_TRULICITY_QTY', 'Trulicity Quantity Validation', 'Trulicity is dispensed as 4 pens per box for 28-day supply. Quantity of 2 pens may indicate partial fill or billing error.', 'quantity_mismatch', ARRAY['TRULICITY', 'DULAGLUTIDE'], 4, 4, 8, 'warning', 6)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, expected_quantity = EXCLUDED.expected_quantity, min_quantity = EXCLUDED.min_quantity, max_quantity = EXCLUDED.max_quantity, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, expected_quantity, min_quantity, max_quantity, severity, audit_risk_score)
    VALUES ('GLP1_MOUNJARO_QTY', 'Mounjaro Quantity Validation', 'Mounjaro is dispensed as 4 pens per box for 28-day supply. Verify quantity matches package size.', 'quantity_mismatch', ARRAY['MOUNJARO', 'TIRZEPATIDE', 'ZEPBOUND'], 4, 2, 8, 'warning', 6)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, min_days_supply, max_days_supply, severity, audit_risk_score)
    VALUES ('GLP1_DAYS_SUPPLY', 'GLP-1 Days Supply Validation', 'GLP-1 injectables typically dispensed as 28 or 30 day supply. Days supply of 42 or 56 may indicate titration packs or billing adjustments.', 'days_supply_mismatch', ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE'], 21, 35, 'info', 4)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, min_days_supply, severity, audit_risk_score)
    VALUES ('GLP1_EARLY_REFILL', 'GLP-1 Early Refill Alert', 'Detects GLP-1 refills more than 7 days before expected based on previous fill date and days supply.', 'early_refill', ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE', 'EXENATIDE'], 7, 'warning', 7)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, gp_threshold, severity, audit_risk_score)
    VALUES ('GLP1_NEGATIVE_MARGIN', 'GLP-1 Negative Margin Alert', 'GLP-1 claims with negative gross profit (losing $900-1000+ per fill). Review contract pricing and acquisition costs immediately.', 'negative_profit', ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE'], 0, 'critical', 9)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, max_quantity, severity, audit_risk_score)
    VALUES ('GLP1_HIGH_QUANTITY', 'GLP-1 High Quantity Alert', 'GLP-1 claims with quantity > 10 units. May indicate compounded products or data entry errors.', 'high_quantity', ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'SEMAGLUTIDE', 'TIRZEPATIDE'], 10, 'critical', 9)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, max_quantity = EXCLUDED.max_quantity, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, severity, audit_risk_score)
    VALUES ('GLP1_DUPLICATE_THERAPY', 'Duplicate GLP-1 Therapy Alert', 'Patient receiving multiple GLP-1 medications from different classes simultaneously. This may be clinically inappropriate.', 'duplicate_therapy', ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS', 'BYETTA', 'BYDUREON', 'SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE', 'EXENATIDE'], 'critical', 9)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, severity, audit_risk_score)
    VALUES ('GLP1_INDICATION_MISMATCH', 'GLP-1 Indication Mismatch', 'Patient receiving both weight loss (Wegovy, Zepbound) and diabetes (Ozempic, Mounjaro) GLP-1 formulations. Review for appropriate therapy selection.', 'indication_mismatch', ARRAY['WEGOVY', 'ZEPBOUND', 'SAXENDA', 'OZEMPIC', 'MOUNJARO', 'TRULICITY', 'VICTOZA'], 'warning', 7)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, allowed_daw_codes, has_generic_available, severity, audit_risk_score)
    VALUES ('GLP1_DAW_CODE', 'GLP-1 DAW Code Check', 'GLP-1 medications have no generic available. DAW code 1 is unnecessary and may cause claim processing issues.', 'daw_violation', ARRAY['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA'], ARRAY['0'], false, 'info', 3)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();

    INSERT INTO audit_rules (rule_code, rule_name, rule_description, rule_type, drug_keywords, severity, audit_risk_score)
    VALUES ('GLP1_COMPOUNDING_RISK', 'GLP-1 Compounding Risk Alert', 'Flags potential compounded GLP-1 products. FDA has issued multiple warnings about safety risks of compounded semaglutide and tirzepatide products.', 'compounding_risk', ARRAY['SEMAGLUTIDE COMPOUND', 'TIRZEPATIDE COMPOUND', 'COMPOUNDED SEMAGLUTIDE', 'COMPOUNDED TIRZEPATIDE', 'COMPOUNDED GLP-1'], 'critical', 10)
    ON CONFLICT (rule_code) DO UPDATE SET rule_description = EXCLUDED.rule_description, updated_at = NOW();
  `;

  await pool.query(sql);

  const count = await pool.query('SELECT COUNT(*) FROM audit_rules');
  console.log('Audit rules re-seeded:', count.rows[0].count, 'rules');

  const rules = await pool.query('SELECT rule_code, rule_name, severity FROM audit_rules ORDER BY audit_risk_score DESC');
  for (const r of rules.rows) {
    console.log(`  [${r.severity}] ${r.rule_code}: ${r.rule_name}`);
  }

  await pool.end();
}
run();
