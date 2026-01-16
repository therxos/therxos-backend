/**
 * GLP-1 Audit Scanner Service
 * Detects dispensing anomalies specific to GLP-1 medications
 * Based on analysis of 3,459 prescriptions finding 1,097 anomalies
 */

import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

// GLP-1 drugs with expected dispensing parameters
const GLP1_DRUGS = {
  'OZEMPIC': { expectedQty: [1, 1.5, 3], expectedDays: [28, 30], maxQty: 6 },
  'WEGOVY': { expectedQty: [0.25, 0.5, 1, 1.7, 2.4], expectedDays: [28, 30], maxQty: 5 },
  'RYBELSUS': { expectedQty: [30, 90], expectedDays: [30, 90], maxQty: 180 },
  'MOUNJARO': { expectedQty: [2, 4], expectedDays: [28, 30], maxQty: 8 },
  'ZEPBOUND': { expectedQty: [2, 4], expectedDays: [28, 30], maxQty: 8 },
  'VICTOZA': { expectedQty: [2, 3], expectedDays: [28, 30], maxQty: 6 },
  'SAXENDA': { expectedQty: [5], expectedDays: [28, 30], maxQty: 10 },
  'TRULICITY': { expectedQty: [2, 4], expectedDays: [14, 28, 30], maxQty: 8 },
  'BYETTA': { expectedQty: [1, 2.4], expectedDays: [28, 30], maxQty: 5 },
  'BYDUREON': { expectedQty: [4], expectedDays: [28, 30], maxQty: 8 }
};

// GLP-1 detection pattern
const GLP1_PATTERN = /OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|BYETTA|BYDUREON|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE|EXENATIDE/i;

// Weight loss vs diabetes formulations
const WEIGHT_LOSS_GLP1 = ['WEGOVY', 'ZEPBOUND', 'SAXENDA'];
const DIABETES_GLP1 = ['OZEMPIC', 'MOUNJARO', 'TRULICITY', 'VICTOZA', 'BYETTA', 'BYDUREON'];

/**
 * Check if a drug name is a GLP-1
 */
export function isGLP1(drugName) {
  return drugName && GLP1_PATTERN.test(drugName);
}

/**
 * Get the GLP-1 class for grouping
 */
function getGLP1Class(drugName) {
  if (!drugName) return null;
  const upper = drugName.toUpperCase();
  if (/OZEMPIC|WEGOVY|RYBELSUS|SEMAGLUTIDE/.test(upper)) return 'SEMAGLUTIDE';
  if (/MOUNJARO|ZEPBOUND|TIRZEPATIDE/.test(upper)) return 'TIRZEPATIDE';
  if (/VICTOZA|SAXENDA|LIRAGLUTIDE/.test(upper)) return 'LIRAGLUTIDE';
  if (/TRULICITY|DULAGLUTIDE/.test(upper)) return 'DULAGLUTIDE';
  if (/BYETTA|BYDUREON|EXENATIDE/.test(upper)) return 'EXENATIDE';
  return null;
}

/**
 * Get expected drug parameters
 */
function getDrugParams(drugName) {
  if (!drugName) return null;
  const upper = drugName.toUpperCase();
  for (const [drug, params] of Object.entries(GLP1_DRUGS)) {
    if (upper.includes(drug)) return { drug, ...params };
  }
  return null;
}

/**
 * Check for compounded GLP-1 indicators
 */
function isLikelyCompounded(drugName, ndc, quantity) {
  if (!drugName) return false;
  const upper = drugName.toUpperCase();

  // Direct compound indicators
  if (/COMPOUND|COMPOUNDED|TROCHE|SUBLINGUAL/.test(upper)) return true;

  // Missing or invalid NDC
  if (!ndc || ndc.length < 11) return true;

  // Unusual quantities for injectable GLP-1s (not Rybelsus)
  if (!upper.includes('RYBELSUS') && quantity > 10) return true;

  // Non-standard formulations
  if (/\d+MG\/\d+\.?\d*ML/.test(upper) && !/PEN|INJ/.test(upper)) return true;

  return false;
}

/**
 * Scan a single prescription for GLP-1 anomalies
 */
async function scanPrescriptionForGLP1Anomalies(rx, pharmacyId) {
  const flags = [];
  const drugParams = getDrugParams(rx.drug_name);
  const glp1Class = getGLP1Class(rx.drug_name);

  if (!glp1Class) return flags; // Not a GLP-1

  const qty = parseFloat(rx.quantity_dispensed) || 0;
  const days = parseInt(rx.days_supply) || 0;
  const grossProfit = (parseFloat(rx.patient_pay) || 0) +
                      (parseFloat(rx.insurance_pay) || 0) -
                      (parseFloat(rx.acquisition_cost) || 0);

  // 1. Quantity Validation
  if (drugParams && qty > 0) {
    const isValidQty = drugParams.expectedQty.some(expected =>
      Math.abs(qty - expected) < 0.1 || (qty > expected && qty % expected === 0)
    );

    if (!isValidQty && qty < drugParams.maxQty) {
      flags.push({
        rule_code: 'GLP1_QTY_VALIDATION',
        rule_type: 'quantity_mismatch',
        severity: 'warning',
        risk_score: 6,
        violation_message: `${drugParams.drug} quantity ${qty} may not match standard package sizes (expected: ${drugParams.expectedQty.join(' or ')})`,
        expected_value: drugParams.expectedQty.join('/'),
        actual_value: qty.toString()
      });
    }
  }

  // 2. High Quantity Alert (potential compounding)
  if (qty > 10 && !/RYBELSUS/.test(rx.drug_name?.toUpperCase())) {
    flags.push({
      rule_code: 'GLP1_HIGH_QUANTITY',
      rule_type: 'high_quantity',
      severity: 'critical',
      risk_score: 9,
      violation_message: `High quantity ${qty} for ${rx.drug_name} - may indicate compounded product or data entry error`,
      expected_value: '1-10',
      actual_value: qty.toString()
    });
  }

  // 3. Days Supply Validation
  if (drugParams && days > 0) {
    const isValidDays = drugParams.expectedDays.some(expected =>
      Math.abs(days - expected) <= 2
    ) || [84, 90].includes(days); // Allow 84/90 day supplies

    if (!isValidDays && days < 84) {
      flags.push({
        rule_code: 'GLP1_DAYS_SUPPLY',
        rule_type: 'days_supply_mismatch',
        severity: 'info',
        risk_score: 4,
        violation_message: `${drugParams.drug} days supply ${days} may not match standard dispensing (expected: ${drugParams.expectedDays.join(' or ')})`,
        expected_value: drugParams.expectedDays.join('/'),
        actual_value: days.toString()
      });
    }
  }

  // 4. Negative Margin Alert
  if (grossProfit < 0) {
    flags.push({
      rule_code: 'GLP1_NEGATIVE_MARGIN',
      rule_type: 'negative_profit',
      severity: 'critical',
      risk_score: 9,
      violation_message: `Negative margin $${grossProfit.toFixed(2)} on ${rx.drug_name} (BIN: ${rx.insurance_bin || 'Unknown'})`,
      expected_value: '>$0',
      actual_value: `$${grossProfit.toFixed(2)}`
    });
  }

  // 5. DAW Code Check (GLP-1s are brand-only)
  if (rx.daw_code && parseInt(rx.daw_code) > 0) {
    flags.push({
      rule_code: 'GLP1_DAW_CODE',
      rule_type: 'daw_violation',
      severity: 'info',
      risk_score: 3,
      violation_message: `DAW code ${rx.daw_code} on ${rx.drug_name} - GLP-1s have no generic available`,
      expected_value: '0',
      actual_value: rx.daw_code
    });
  }

  // 6. Compounding Risk Check
  if (isLikelyCompounded(rx.drug_name, rx.ndc, qty)) {
    flags.push({
      rule_code: 'GLP1_COMPOUNDING_RISK',
      rule_type: 'compounding_risk',
      severity: 'critical',
      risk_score: 10,
      violation_message: `Potential compounded GLP-1: ${rx.drug_name} (NDC: ${rx.ndc || 'Missing'}). FDA has issued warnings about compounded semaglutide/tirzepatide.`,
      expected_value: 'FDA-approved product',
      actual_value: rx.drug_name
    });
  }

  return flags;
}

/**
 * Check for early refills for a patient's GLP-1
 */
async function checkEarlyRefill(rx, patientId) {
  const glp1Class = getGLP1Class(rx.drug_name);
  if (!glp1Class) return null;

  try {
    const prevFill = await db.query(`
      SELECT dispensed_date, days_supply
      FROM prescriptions
      WHERE patient_id = $1
        AND drug_name ~* $2
        AND dispensed_date < $3
      ORDER BY dispensed_date DESC
      LIMIT 1
    `, [patientId, glp1Class, rx.dispensed_date]);

    if (prevFill.rows.length === 0) return null;

    const prev = prevFill.rows[0];
    const daysBetween = Math.floor(
      (new Date(rx.dispensed_date) - new Date(prev.dispensed_date)) / (1000 * 60 * 60 * 24)
    );
    const expectedDays = parseInt(prev.days_supply) || 28;
    const daysEarly = expectedDays - daysBetween;

    if (daysEarly > 7 && daysBetween > 0) {
      return {
        rule_code: 'GLP1_EARLY_REFILL',
        rule_type: 'early_refill',
        severity: 'warning',
        risk_score: 7,
        violation_message: `Early refill: ${rx.drug_name} filled ${daysEarly} days early (${daysBetween} days since last fill, expected ${expectedDays})`,
        expected_value: `>${expectedDays - 7} days`,
        actual_value: `${daysBetween} days`
      };
    }
  } catch (error) {
    logger.error('Error checking early refill', { error: error.message, patientId });
  }

  return null;
}

/**
 * Check for duplicate GLP-1 therapy
 */
async function checkDuplicateTherapy(patientId, lookbackDays = 90) {
  try {
    const result = await db.query(`
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
      WHERE patient_id = $1
        AND drug_name ~* $2
        AND dispensed_date >= CURRENT_DATE - ($3 || ' days')::INTERVAL
    `, [patientId, GLP1_PATTERN.source, lookbackDays]);

    const classes = [...new Set(result.rows.map(r => r.glp1_class))];
    const drugs = result.rows.map(r => r.drug_name);

    if (classes.length > 1) {
      return {
        rule_code: 'GLP1_DUPLICATE_THERAPY',
        rule_type: 'duplicate_therapy',
        severity: 'critical',
        risk_score: 9,
        violation_message: `Duplicate GLP-1 therapy: Patient receiving ${classes.join(' and ')} (${drugs.join(', ')})`,
        expected_value: '1 GLP-1 class',
        actual_value: `${classes.length} classes`
      };
    }

    // Also check for weight loss + diabetes indication mismatch
    const hasWeightLoss = drugs.some(d => WEIGHT_LOSS_GLP1.some(w => d.toUpperCase().includes(w)));
    const hasDiabetes = drugs.some(d => DIABETES_GLP1.some(db => d.toUpperCase().includes(db)));

    if (hasWeightLoss && hasDiabetes) {
      return {
        rule_code: 'GLP1_INDICATION_MISMATCH',
        rule_type: 'indication_mismatch',
        severity: 'warning',
        risk_score: 7,
        violation_message: `Indication mismatch: Patient receiving both weight loss (${drugs.filter(d => WEIGHT_LOSS_GLP1.some(w => d.toUpperCase().includes(w))).join(', ')}) and diabetes GLP-1 (${drugs.filter(d => DIABETES_GLP1.some(db => d.toUpperCase().includes(db))).join(', ')})`,
        expected_value: 'Single indication',
        actual_value: 'Multiple indications'
      };
    }
  } catch (error) {
    logger.error('Error checking duplicate therapy', { error: error.message, patientId });
  }

  return null;
}

/**
 * Create audit flag record in database
 */
async function createAuditFlag(flag, rx, pharmacyId) {
  try {
    // Get the rule_id from audit_rules if it exists
    const ruleResult = await db.query(
      'SELECT rule_id FROM audit_rules WHERE rule_code = $1',
      [flag.rule_code]
    );
    const ruleId = ruleResult.rows[0]?.rule_id || null;

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
      rx.patient_id,
      rx.prescription_id,
      ruleId,
      flag.rule_type,
      flag.severity,
      rx.drug_name,
      rx.ndc,
      rx.quantity_dispensed,
      rx.days_supply,
      rx.daw_code,
      (parseFloat(rx.patient_pay) || 0) + (parseFloat(rx.insurance_pay) || 0) - (parseFloat(rx.acquisition_cost) || 0),
      flag.violation_message,
      flag.expected_value,
      flag.actual_value,
      rx.dispensed_date,
      'open'
    ]);

    return true;
  } catch (error) {
    logger.error('Error creating audit flag', { error: error.message, ruleCode: flag.rule_code });
    return false;
  }
}

/**
 * Run GLP-1 audit scan for a pharmacy
 */
export async function runGLP1AuditScan(pharmacyId = null, options = {}) {
  const { lookbackDays = 30, createFlags = true } = options;

  const batchId = `glp1_audit_${Date.now()}`;
  const startTime = Date.now();

  logger.info('Starting GLP-1 audit scan', { batchId, pharmacyId, lookbackDays });

  try {
    // Get GLP-1 prescriptions
    const whereClause = pharmacyId
      ? 'AND pharmacy_id = $2'
      : '';
    const params = pharmacyId
      ? [GLP1_PATTERN.source, pharmacyId, lookbackDays]
      : [GLP1_PATTERN.source, lookbackDays];

    const prescriptions = await db.query(`
      SELECT
        prescription_id, pharmacy_id, patient_id, rx_number,
        drug_name, ndc, quantity_dispensed, days_supply, daw_code,
        dispensed_date, prescriber_name, prescriber_npi,
        insurance_bin, insurance_group, patient_pay, insurance_pay, acquisition_cost
      FROM prescriptions
      WHERE drug_name ~* $1
        ${whereClause}
        AND dispensed_date >= CURRENT_DATE - ($${params.length} || ' days')::INTERVAL
      ORDER BY dispensed_date DESC
    `, params);

    logger.info(`Found ${prescriptions.rows.length} GLP-1 prescriptions to audit`);

    const results = {
      batchId,
      prescriptionsScanned: prescriptions.rows.length,
      anomalies: {
        quantity: [],
        daysSupply: [],
        earlyRefill: [],
        negativeMargin: [],
        duplicateTherapy: [],
        compounding: [],
        dawCode: [],
        indicationMismatch: [],
        highQuantity: []
      },
      flagsCreated: 0
    };

    // Track patients already checked for duplicate therapy
    const checkedPatients = new Set();

    for (const rx of prescriptions.rows) {
      // Single prescription anomalies
      const flags = await scanPrescriptionForGLP1Anomalies(rx, pharmacyId);

      // Early refill check
      const earlyRefillFlag = await checkEarlyRefill(rx, rx.patient_id);
      if (earlyRefillFlag) flags.push(earlyRefillFlag);

      // Duplicate therapy check (once per patient)
      if (!checkedPatients.has(rx.patient_id)) {
        checkedPatients.add(rx.patient_id);
        const duplicateFlag = await checkDuplicateTherapy(rx.patient_id);
        if (duplicateFlag) flags.push(duplicateFlag);
      }

      // Categorize and store flags
      for (const flag of flags) {
        switch (flag.rule_code) {
          case 'GLP1_QTY_VALIDATION':
            results.anomalies.quantity.push({ rx, flag });
            break;
          case 'GLP1_HIGH_QUANTITY':
            results.anomalies.highQuantity.push({ rx, flag });
            break;
          case 'GLP1_DAYS_SUPPLY':
            results.anomalies.daysSupply.push({ rx, flag });
            break;
          case 'GLP1_EARLY_REFILL':
            results.anomalies.earlyRefill.push({ rx, flag });
            break;
          case 'GLP1_NEGATIVE_MARGIN':
            results.anomalies.negativeMargin.push({ rx, flag });
            break;
          case 'GLP1_DUPLICATE_THERAPY':
            results.anomalies.duplicateTherapy.push({ rx, flag });
            break;
          case 'GLP1_COMPOUNDING_RISK':
            results.anomalies.compounding.push({ rx, flag });
            break;
          case 'GLP1_DAW_CODE':
            results.anomalies.dawCode.push({ rx, flag });
            break;
          case 'GLP1_INDICATION_MISMATCH':
            results.anomalies.indicationMismatch.push({ rx, flag });
            break;
        }

        // Create audit flag in database
        if (createFlags && flag.severity !== 'info') {
          const created = await createAuditFlag(flag, rx, rx.pharmacy_id);
          if (created) results.flagsCreated++;
        }
      }
    }

    const duration = Date.now() - startTime;
    const totalAnomalies = Object.values(results.anomalies)
      .reduce((sum, arr) => sum + arr.length, 0);

    logger.info('GLP-1 audit scan complete', {
      batchId,
      duration: `${duration}ms`,
      prescriptionsScanned: results.prescriptionsScanned,
      totalAnomalies,
      flagsCreated: results.flagsCreated
    });

    return results;

  } catch (error) {
    logger.error('GLP-1 audit scan failed', { error: error.message, batchId });
    throw error;
  }
}

/**
 * Get GLP-1 negative margin summary by BIN
 */
export async function getGLP1NegativeMarginByBIN(pharmacyId = null, lookbackDays = 90) {
  const whereClause = pharmacyId ? 'AND pharmacy_id = $2' : '';
  const params = pharmacyId ? [lookbackDays, pharmacyId] : [lookbackDays];

  const result = await db.query(`
    SELECT
      insurance_bin,
      COUNT(*) as claim_count,
      SUM(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as total_loss,
      AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as avg_loss,
      ARRAY_AGG(DISTINCT drug_name) as drugs
    FROM prescriptions
    WHERE drug_name ~* $${pharmacyId ? 3 : 2}
      ${whereClause}
      AND dispensed_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      AND (COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) < 0
    GROUP BY insurance_bin
    ORDER BY total_loss ASC
  `, [...params, GLP1_PATTERN.source]);

  return result.rows;
}

export default {
  isGLP1,
  getGLP1Class,
  runGLP1AuditScan,
  getGLP1NegativeMarginByBIN,
  scanPrescriptionForGLP1Anomalies,
  checkEarlyRefill,
  checkDuplicateTherapy
};
