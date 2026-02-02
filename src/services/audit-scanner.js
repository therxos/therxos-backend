/**
 * Audit Scanner Service
 * Consolidates all audit scanning logic for TheRxOS V2
 * Runs audit rules against prescriptions and populates audit_flags table
 */

import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import glp1Scanner from './glp1-audit-scanner.js';

// ============================================
// AUDIT RULE DEFINITIONS
// ============================================

const AUDIT_RULES = {
  // GLP-1 specific rules are handled by glp1-audit-scanner.js
  // These are general audit rules

  HIGH_GP_RISK: {
    name: 'High Gross Profit Risk',
    rule_type: 'high_gp_risk',
    severity: 'warning',
    risk_score: 6,
    threshold: 50,
    detection: /.*/,
    check: (rx) => {
      const grossProfit = (parseFloat(rx.patient_pay) || 0) +
                          (parseFloat(rx.insurance_pay) || 0) -
                          (parseFloat(rx.acquisition_cost) || 0);

      if (grossProfit > 50) {
        return {
          violation: true,
          message: `High gross profit $${grossProfit.toFixed(2)} on ${rx.drug_name} - may attract PBM audit scrutiny`,
          expected: '<$50',
          actual: `$${grossProfit.toFixed(2)}`,
          gross_profit: grossProfit
        };
      }
      return { violation: false };
    }
  },

  SYNTHROID_DAW: {
    name: 'Synthroid DAW Code Check',
    rule_type: 'daw_violation',
    severity: 'critical',
    risk_score: 8,
    detection: /SYNTHROID/i,
    check: (rx) => {
      const daw = rx.daw_code || '0';
      if (daw === '0' || daw === '') {
        return {
          violation: true,
          message: `Synthroid dispensed with DAW 0 - generic levothyroxine available. Must have DAW 1, 2, or 9.`,
          expected: '1, 2, or 9',
          actual: daw || '0'
        };
      }
      return { violation: false };
    }
  },

  DAYS_SUPPLY_MISMATCH: {
    name: 'Days Supply Validation',
    rule_type: 'days_supply_mismatch',
    severity: 'warning',
    risk_score: 5,
    detection: /.*/,
    check: (rx) => {
      const days = parseInt(rx.days_supply) || 0;
      const qty = parseFloat(rx.quantity_dispensed) || 0;
      const sig = (rx.sig || '').toLowerCase();

      if (!days || !qty || !sig) return { violation: false };

      let expectedDaily = 1;
      if (sig.includes('bid') || sig.includes('twice')) expectedDaily = 2;
      else if (sig.includes('tid') || sig.includes('three times')) expectedDaily = 3;
      else if (sig.includes('qid') || sig.includes('four times')) expectedDaily = 4;

      const calculatedDays = qty / expectedDaily;
      const variance = Math.abs(calculatedDays - days) / days;

      if (variance > 0.2 && calculatedDays > 5) {
        return {
          violation: true,
          message: `Days supply (${days}) doesn't match SIG calculation (~${Math.round(calculatedDays)} days).`,
          expected: `~${Math.round(calculatedDays)} days`,
          actual: `${days} days`
        };
      }
      return { violation: false };
    }
  },

  CONTROLLED_MISSING_NPI: {
    name: 'Controlled Substance Missing Prescriber NPI',
    rule_type: 'missing_npi',
    severity: 'critical',
    risk_score: 9,
    detection: /OXYCODONE|HYDROCODONE|FENTANYL|MORPHINE|ALPRAZOLAM|LORAZEPAM|CLONAZEPAM|DIAZEPAM|ADDERALL|RITALIN|VYVANSE|CONCERTA|TRAMADOL|CODEINE|OXYCONTIN|PERCOCET|VICODIN|NORCO|XANAX|ATIVAN|KLONOPIN|VALIUM/i,
    check: (rx) => {
      if (!rx.prescriber_npi || rx.prescriber_npi.trim() === '') {
        return {
          violation: true,
          message: `Controlled substance ${rx.drug_name} dispensed without prescriber NPI - compliance risk`,
          expected: 'Valid 10-digit NPI',
          actual: 'Missing'
        };
      }
      return { violation: false };
    }
  },

  BRAND_WITHOUT_DAW: {
    name: 'Brand Drug Without DAW Code',
    rule_type: 'daw_violation',
    severity: 'warning',
    risk_score: 5,
    // Common brand drugs with generics
    detection: /LIPITOR|CRESTOR|NEXIUM|PREVACID|PROTONIX|EFFEXOR|CYMBALTA|LEXAPRO|CELEBREX|LYRICA|DIOVAN|BENICAR|AVAPRO|NORVASC|LOTREL/i,
    check: (rx) => {
      const daw = rx.daw_code || '0';
      if (daw === '0' || daw === '') {
        return {
          violation: true,
          message: `Brand drug ${rx.drug_name} dispensed with DAW 0 - generic may be available`,
          expected: 'DAW 1 or 2 if brand preferred',
          actual: daw || '0'
        };
      }
      return { violation: false };
    }
  }
};

/**
 * Run general audit rules against prescriptions
 */
async function runGeneralAuditRules(pharmacyId, prescriptions) {
  const flags = [];

  for (const [ruleCode, rule] of Object.entries(AUDIT_RULES)) {
    for (const rx of prescriptions) {
      if (!rule.detection.test(rx.drug_name)) continue;

      const result = rule.check(rx);

      if (result.violation) {
        flags.push({
          prescription_id: rx.prescription_id,
          patient_id: rx.patient_id,
          drug_name: rx.drug_name,
          ndc: rx.ndc,
          quantity_dispensed: rx.quantity_dispensed,
          days_supply: rx.days_supply,
          daw_code: rx.daw_code,
          dispensed_date: rx.dispensed_date,
          gross_profit: result.gross_profit,
          rule_code: ruleCode,
          rule_type: rule.rule_type,
          severity: rule.severity,
          risk_score: rule.risk_score,
          violation_message: result.message,
          expected_value: result.expected,
          actual_value: result.actual
        });
      }
    }
  }

  return flags;
}

/**
 * Load database-defined audit rules
 */
async function loadDatabaseRules() {
  const result = await db.query(`
    SELECT rule_id, rule_code, rule_name, rule_type, drug_keywords,
           expected_quantity, min_quantity, max_quantity,
           min_days_supply, max_days_supply,
           allowed_daw_codes, has_generic_available,
           gp_threshold, severity, audit_risk_score, is_enabled
    FROM audit_rules
    WHERE is_enabled = true
  `);
  return result.rows;
}

/**
 * Check prescription against database-defined rules
 */
function checkDatabaseRule(rx, rule) {
  // Check if drug matches keywords
  if (rule.drug_keywords && rule.drug_keywords.length > 0) {
    const drugUpper = (rx.drug_name || '').toUpperCase();
    const matches = rule.drug_keywords.some(kw => drugUpper.includes(kw.toUpperCase()));
    if (!matches) return { violation: false };
  }

  const qty = parseFloat(rx.quantity_dispensed) || 0;
  const days = parseInt(rx.days_supply) || 0;
  const daw = rx.daw_code || '0';
  const grossProfit = (parseFloat(rx.patient_pay) || 0) +
                      (parseFloat(rx.insurance_pay) || 0) -
                      (parseFloat(rx.acquisition_cost) || 0);

  switch (rule.rule_type) {
    case 'quantity_mismatch':
      if (rule.expected_quantity && Math.abs(qty - rule.expected_quantity) > 0.1) {
        return {
          violation: true,
          message: `${rx.drug_name} quantity ${qty} doesn't match expected ${rule.expected_quantity}`,
          expected: rule.expected_quantity.toString(),
          actual: qty.toString()
        };
      }
      if (rule.min_quantity && qty < rule.min_quantity) {
        return {
          violation: true,
          message: `${rx.drug_name} quantity ${qty} below minimum ${rule.min_quantity}`,
          expected: `>=${rule.min_quantity}`,
          actual: qty.toString()
        };
      }
      if (rule.max_quantity && qty > rule.max_quantity) {
        return {
          violation: true,
          message: `${rx.drug_name} quantity ${qty} exceeds maximum ${rule.max_quantity}`,
          expected: `<=${rule.max_quantity}`,
          actual: qty.toString()
        };
      }
      break;

    case 'days_supply_mismatch':
      if (rule.min_days_supply && days < rule.min_days_supply) {
        return {
          violation: true,
          message: `${rx.drug_name} days supply ${days} below minimum ${rule.min_days_supply}`,
          expected: `>=${rule.min_days_supply}`,
          actual: days.toString()
        };
      }
      if (rule.max_days_supply && days > rule.max_days_supply) {
        return {
          violation: true,
          message: `${rx.drug_name} days supply ${days} exceeds maximum ${rule.max_days_supply}`,
          expected: `<=${rule.max_days_supply}`,
          actual: days.toString()
        };
      }
      break;

    case 'daw_violation':
      if (rule.allowed_daw_codes && !rule.allowed_daw_codes.includes(daw)) {
        return {
          violation: true,
          message: `${rx.drug_name} DAW code ${daw} not in allowed list: ${rule.allowed_daw_codes.join(', ')}`,
          expected: rule.allowed_daw_codes.join(', '),
          actual: daw
        };
      }
      break;

    case 'high_gp_risk':
      if (rule.gp_threshold && grossProfit > rule.gp_threshold) {
        return {
          violation: true,
          message: `${rx.drug_name} gross profit $${grossProfit.toFixed(2)} exceeds threshold $${rule.gp_threshold}`,
          expected: `<$${rule.gp_threshold}`,
          actual: `$${grossProfit.toFixed(2)}`,
          gross_profit: grossProfit
        };
      }
      break;
  }

  return { violation: false };
}

/**
 * Create audit flag record in database
 */
async function createAuditFlag(flag, pharmacyId, ruleIdMap) {
  try {
    await db.query(`
      INSERT INTO audit_flags (
        flag_id, pharmacy_id, patient_id, prescription_id, rule_id,
        rule_type, severity, drug_name, ndc, dispensed_quantity,
        days_supply, daw_code, gross_profit, violation_message,
        expected_value, actual_value, dispensed_date, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT DO NOTHING
    `, [
      uuidv4(),
      pharmacyId,
      flag.patient_id,
      flag.prescription_id,
      ruleIdMap.get(flag.rule_code) || null,
      flag.rule_type,
      flag.severity,
      flag.drug_name,
      flag.ndc,
      flag.quantity_dispensed,
      flag.days_supply,
      flag.daw_code,
      flag.gross_profit || null,
      flag.violation_message,
      flag.expected_value,
      flag.actual_value,
      flag.dispensed_date,
      'open'
    ]);
    return true;
  } catch (error) {
    logger.error('Error creating audit flag', { error: error.message, ruleCode: flag.rule_code });
    return false;
  }
}

/**
 * Run full audit scan for a pharmacy
 */
export async function runFullAuditScan(pharmacyId, options = {}) {
  const {
    lookbackDays = 90,
    clearExisting = true,
    includeGLP1 = true,
    includeGeneral = true,
    includeDatabaseRules = true
  } = options;

  const batchId = `audit_${Date.now()}`;
  const startTime = Date.now();

  logger.info('Starting full audit scan', { batchId, pharmacyId, lookbackDays });

  try {
    // Get prescriptions
    const rxResult = await db.query(`
      SELECT
        prescription_id, patient_id, drug_name, ndc,
        quantity_dispensed, days_supply, daw_code, sig,
        dispensed_date, prescriber_name, prescriber_npi,
        insurance_bin, insurance_group, patient_pay, insurance_pay, acquisition_cost, raw_data
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND dispensed_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      ORDER BY dispensed_date DESC
    `, [pharmacyId, lookbackDays]);

    logger.info(`Found ${rxResult.rows.length} prescriptions to audit`);

    const allFlags = [];

    // Run GLP-1 specific audits
    if (includeGLP1) {
      const glp1Results = await glp1Scanner.runGLP1AuditScan(pharmacyId, {
        lookbackDays,
        createFlags: false  // We'll create flags ourselves
      });

      for (const category of Object.values(glp1Results.anomalies)) {
        for (const { rx, flag } of category) {
          allFlags.push({
            prescription_id: rx.prescription_id,
            patient_id: rx.patient_id,
            drug_name: rx.drug_name,
            ndc: rx.ndc,
            quantity_dispensed: rx.quantity_dispensed,
            days_supply: rx.days_supply,
            daw_code: rx.daw_code,
            dispensed_date: rx.dispensed_date,
            gross_profit: parseFloat(rx.raw_data?.gross_profit || rx.raw_data?.net_profit || rx.raw_data?.['Gross Profit'] || rx.raw_data?.['Net Profit'] || 0),
            ...flag
          });
        }
      }
    }

    // Run general audit rules
    if (includeGeneral) {
      const generalFlags = await runGeneralAuditRules(pharmacyId, rxResult.rows);
      allFlags.push(...generalFlags);
    }

    // Run database-defined rules
    if (includeDatabaseRules) {
      const dbRules = await loadDatabaseRules();

      for (const rule of dbRules) {
        for (const rx of rxResult.rows) {
          const result = checkDatabaseRule(rx, rule);

          if (result.violation) {
            allFlags.push({
              prescription_id: rx.prescription_id,
              patient_id: rx.patient_id,
              drug_name: rx.drug_name,
              ndc: rx.ndc,
              quantity_dispensed: rx.quantity_dispensed,
              days_supply: rx.days_supply,
              daw_code: rx.daw_code,
              dispensed_date: rx.dispensed_date,
              gross_profit: result.gross_profit,
              rule_code: rule.rule_code,
              rule_type: rule.rule_type,
              severity: rule.severity,
              risk_score: rule.audit_risk_score,
              violation_message: result.message,
              expected_value: result.expected,
              actual_value: result.actual
            });
          }
        }
      }
    }

    // Clear existing open flags if requested
    if (clearExisting) {
      await db.query(`
        DELETE FROM audit_flags
        WHERE pharmacy_id = $1 AND status = 'open'
      `, [pharmacyId]);
    }

    // Get rule ID map for linking
    const rulesResult = await db.query('SELECT rule_id, rule_code FROM audit_rules');
    const ruleIdMap = new Map(rulesResult.rows.map(r => [r.rule_code, r.rule_id]));

    // Insert flags
    let inserted = 0;
    let errors = 0;

    for (const flag of allFlags) {
      const success = await createAuditFlag(flag, pharmacyId, ruleIdMap);
      if (success) inserted++;
      else errors++;
    }

    const duration = Date.now() - startTime;

    logger.info('Audit scan complete', {
      batchId,
      duration: `${duration}ms`,
      prescriptionsScanned: rxResult.rows.length,
      flagsCreated: inserted,
      errors
    });

    // Get summary
    const summary = await db.query(`
      SELECT severity, COUNT(*) as count
      FROM audit_flags
      WHERE pharmacy_id = $1 AND status = 'open'
      GROUP BY severity
    `, [pharmacyId]);

    return {
      batchId,
      prescriptionsScanned: rxResult.rows.length,
      flagsCreated: inserted,
      errors,
      summary: summary.rows
    };

  } catch (error) {
    logger.error('Audit scan failed', { error: error.message, batchId });
    throw error;
  }
}

/**
 * Run audit scan for all active pharmacies
 */
export async function runAuditScanAll(options = {}) {
  const pharmacies = await db.query(`
    SELECT p.pharmacy_id, p.pharmacy_name
    FROM pharmacies p
    JOIN clients c ON c.client_id = p.client_id
    WHERE c.status = 'active'
  `);

  logger.info(`Running audit scan for ${pharmacies.rows.length} pharmacies`);

  const results = [];

  for (const pharmacy of pharmacies.rows) {
    try {
      const result = await runFullAuditScan(pharmacy.pharmacy_id, options);
      results.push({ pharmacy_id: pharmacy.pharmacy_id, name: pharmacy.pharmacy_name, ...result });
    } catch (error) {
      logger.error(`Audit scan failed for ${pharmacy.pharmacy_name}`, { error: error.message });
      results.push({ pharmacy_id: pharmacy.pharmacy_id, name: pharmacy.pharmacy_name, error: error.message });
    }
  }

  return results;
}

/**
 * Get audit flag summary for a pharmacy
 */
export async function getAuditSummary(pharmacyId) {
  const [bySeverity, byType, recent] = await Promise.all([
    db.query(`
      SELECT severity, COUNT(*) as count
      FROM audit_flags
      WHERE pharmacy_id = $1 AND status = 'open'
      GROUP BY severity
      ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END
    `, [pharmacyId]),

    db.query(`
      SELECT rule_type, COUNT(*) as count
      FROM audit_flags
      WHERE pharmacy_id = $1 AND status = 'open'
      GROUP BY rule_type
      ORDER BY count DESC
    `, [pharmacyId]),

    db.query(`
      SELECT flag_id, rule_type, severity, drug_name, violation_message, dispensed_date
      FROM audit_flags
      WHERE pharmacy_id = $1 AND status = 'open'
      ORDER BY
        CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
        flagged_at DESC
      LIMIT 10
    `, [pharmacyId])
  ]);

  return {
    bySeverity: bySeverity.rows,
    byType: byType.rows,
    recentFlags: recent.rows,
    totalOpen: bySeverity.rows.reduce((sum, r) => sum + parseInt(r.count), 0)
  };
}

/**
 * Run audit scan for a specific rule on a specific pharmacy
 */
export async function runRuleScan(pharmacyId, ruleId, options = {}) {
  const { lookbackDays = 90 } = options;

  const batchId = `audit_rule_${Date.now()}`;
  const startTime = Date.now();

  logger.info('Starting rule-specific audit scan', { batchId, pharmacyId, ruleId, lookbackDays });

  try {
    // Get the specific rule
    const ruleResult = await db.query('SELECT * FROM audit_rules WHERE rule_id = $1 AND is_enabled = true', [ruleId]);
    if (ruleResult.rows.length === 0) {
      return { flagsCreated: 0, patientsAffected: 0, message: 'Rule not found or not enabled' };
    }
    const rule = ruleResult.rows[0];

    // Get prescriptions
    const rxResult = await db.query(`
      SELECT
        prescription_id, patient_id, drug_name, ndc,
        quantity_dispensed, days_supply, daw_code, sig,
        dispensed_date, prescriber_name, prescriber_npi,
        insurance_bin, insurance_group, patient_pay, insurance_pay, acquisition_cost, raw_data
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND dispensed_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      ORDER BY dispensed_date DESC
    `, [pharmacyId, lookbackDays]);

    logger.info(`Found ${rxResult.rows.length} prescriptions to check against rule ${rule.rule_code}`);

    const flagsToCreate = [];
    const patientsAffected = new Set();

    // Check rule against all prescriptions
    for (const rx of rxResult.rows) {
      const result = checkDatabaseRule(rx, rule);

      if (result.violation) {
        patientsAffected.add(rx.patient_id);
        flagsToCreate.push({
          pharmacy_id: pharmacyId,
          prescription_id: rx.prescription_id,
          patient_id: rx.patient_id,
          rule_id: rule.rule_id,
          rule_code: rule.rule_code,
          rule_type: rule.rule_type,
          severity: rule.severity,
          risk_score: rule.audit_risk_score,
          drug_name: rx.drug_name,
          ndc: rx.ndc,
          quantity_dispensed: rx.quantity_dispensed,
          days_supply: rx.days_supply,
          daw_code: rx.daw_code,
          dispensed_date: rx.dispensed_date,
          violation_message: result.message,
          expected_value: result.expected,
          actual_value: result.actual,
          gross_profit: result.gross_profit,
          potential_audit_exposure: result.gross_profit || 0,
          status: 'pending',
          batch_id: batchId
        });
      }
    }

    // Save flags to database
    let flagsCreated = 0;
    for (const flag of flagsToCreate) {
      const saved = await saveAuditFlag(flag);
      if (saved) flagsCreated++;
    }

    const duration = Date.now() - startTime;
    logger.info('Rule-specific audit scan complete', {
      batchId,
      pharmacyId,
      ruleId,
      flagsCreated,
      patientsAffected: patientsAffected.size,
      duration: `${duration}ms`
    });

    return {
      flagsCreated,
      patientsAffected: patientsAffected.size,
      prescriptionsChecked: rxResult.rows.length,
      ruleCode: rule.rule_code,
      ruleName: rule.rule_name
    };
  } catch (error) {
    logger.error('Rule-specific audit scan failed', { error: error.message, pharmacyId, ruleId });
    throw error;
  }
}

export default {
  runFullAuditScan,
  runAuditScanAll,
  runRuleScan,
  getAuditSummary,
  AUDIT_RULES
};
