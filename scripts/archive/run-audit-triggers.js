// TheRxOS V2 - Audit Trigger Scanner
// Scans prescriptions against audit rules and populates audit_flags table
// Run with: node run-audit-triggers.js [client-email] [--all]

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ============================================
// AUDIT RULE DEFINITIONS
// These supplement the database audit_rules table
// ============================================

const AUDIT_RULES = {
  // GLP-1 Rules
  GLP1_QTY_VALIDATION: {
    name: 'GLP-1 Quantity Validation',
    rule_type: 'quantity_mismatch',
    severity: 'warning',
    risk_score: 6,
    detection: /OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE/i,
    expected_quantities: {
      'OZEMPIC': [1, 1.5, 3],
      'WEGOVY': [0.25, 0.5, 1, 1.7, 2.4],
      'MOUNJARO': [2, 4],
      'ZEPBOUND': [2, 4],
      'TRULICITY': [2, 4],
      'VICTOZA': [2, 3],
      'SAXENDA': [5],
      'RYBELSUS': [30, 90],
    },
    check: (rx) => {
      const qty = parseFloat(rx.quantity_dispensed) || 0;
      const drugUpper = (rx.drug_name || '').toUpperCase();

      for (const [drug, expectedQtys] of Object.entries(AUDIT_RULES.GLP1_QTY_VALIDATION.expected_quantities)) {
        if (drugUpper.includes(drug)) {
          const isValid = expectedQtys.some(exp => Math.abs(qty - exp) < 0.1 || (qty > exp && qty % exp === 0));
          if (!isValid && qty > 0 && qty < 20) {
            return {
              violation: true,
              message: `${drug} quantity ${qty} may not match standard package sizes (expected: ${expectedQtys.join(' or ')})`,
              expected: expectedQtys.join('/'),
              actual: qty.toString()
            };
          }
        }
      }
      return { violation: false };
    }
  },

  GLP1_HIGH_QUANTITY: {
    name: 'GLP-1 High Quantity Alert',
    rule_type: 'high_quantity',
    severity: 'critical',
    risk_score: 9,
    detection: /OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|SEMAGLUTIDE|TIRZEPATIDE/i,
    check: (rx) => {
      const qty = parseFloat(rx.quantity_dispensed) || 0;
      const drugUpper = (rx.drug_name || '').toUpperCase();

      // Rybelsus is tablets, so high qty is expected
      if (drugUpper.includes('RYBELSUS')) return { violation: false };

      if (qty > 10) {
        return {
          violation: true,
          message: `High quantity ${qty} for ${rx.drug_name} - may indicate compounded product or data entry error`,
          expected: '1-10',
          actual: qty.toString()
        };
      }
      return { violation: false };
    }
  },

  GLP1_NEGATIVE_MARGIN: {
    name: 'GLP-1 Negative Margin Alert',
    rule_type: 'negative_profit',
    severity: 'critical',
    risk_score: 9,
    detection: /OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE/i,
    check: (rx) => {
      const grossProfit = (parseFloat(rx.patient_pay) || 0) +
                          (parseFloat(rx.insurance_pay) || 0) -
                          (parseFloat(rx.acquisition_cost) || 0);

      if (grossProfit < 0) {
        return {
          violation: true,
          message: `Negative margin $${grossProfit.toFixed(2)} on ${rx.drug_name} (BIN: ${rx.insurance_bin || 'Unknown'})`,
          expected: '>$0',
          actual: `$${grossProfit.toFixed(2)}`,
          gross_profit: grossProfit
        };
      }
      return { violation: false };
    }
  },

  GLP1_DAW_CODE: {
    name: 'GLP-1 DAW Code Check',
    rule_type: 'daw_violation',
    severity: 'info',
    risk_score: 3,
    detection: /OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA/i,
    check: (rx) => {
      const daw = parseInt(rx.daw_code) || 0;
      if (daw > 0) {
        return {
          violation: true,
          message: `DAW code ${rx.daw_code} on ${rx.drug_name} - GLP-1s have no generic available`,
          expected: '0',
          actual: rx.daw_code
        };
      }
      return { violation: false };
    }
  },

  GLP1_COMPOUNDING_RISK: {
    name: 'GLP-1 Compounding Risk Alert',
    rule_type: 'compounding_risk',
    severity: 'critical',
    risk_score: 10,
    detection: /SEMAGLUTIDE|TIRZEPATIDE/i,
    check: (rx) => {
      const drugUpper = (rx.drug_name || '').toUpperCase();
      const ndc = rx.ndc || '';
      const qty = parseFloat(rx.quantity_dispensed) || 0;

      // Check for compound indicators
      const isCompound =
        /COMPOUND|COMPOUNDED|TROCHE|SUBLINGUAL/.test(drugUpper) ||
        ndc.length < 11 ||
        !ndc ||
        (qty > 10 && !/RYBELSUS/.test(drugUpper));

      if (isCompound) {
        return {
          violation: true,
          message: `Potential compounded GLP-1: ${rx.drug_name} (NDC: ${ndc || 'Missing'}). FDA has issued warnings about compounded semaglutide/tirzepatide.`,
          expected: 'FDA-approved product',
          actual: rx.drug_name
        };
      }
      return { violation: false };
    }
  },

  // Ozempic specific
  OZEMPIC_QTY: {
    name: 'Ozempic Quantity Check',
    rule_type: 'quantity_mismatch',
    severity: 'critical',
    risk_score: 9,
    detection: /OZEMPIC/i,
    check: (rx) => {
      const qty = parseFloat(rx.quantity_dispensed) || 0;
      // Ozempic pens come as 3ml
      if (qty !== 1 && qty !== 1.5 && qty !== 3 && qty !== 6) {
        return {
          violation: true,
          message: `Ozempic quantity ${qty}ml is non-standard. Expected 1, 1.5, 3, or 6ml.`,
          expected: '1, 1.5, 3, or 6',
          actual: qty.toString()
        };
      }
      return { violation: false };
    }
  },

  // High GP Risk
  HIGH_GP_RISK: {
    name: 'High Gross Profit Risk',
    rule_type: 'high_gp_risk',
    severity: 'warning',
    risk_score: 6,
    detection: /.*/,  // Applies to all drugs
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

  // Synthroid DAW
  SYNTHROID_DAW: {
    name: 'Synthroid DAW Code Check',
    rule_type: 'daw_violation',
    severity: 'critical',
    risk_score: 8,
    detection: /SYNTHROID/i,
    check: (rx) => {
      const daw = rx.daw_code || '0';
      // Synthroid has generic (levothyroxine) - needs DAW 1, 2, or 9 for brand
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

  // Days Supply Mismatch
  DAYS_SUPPLY_MISMATCH: {
    name: 'Days Supply Validation',
    rule_type: 'days_supply_mismatch',
    severity: 'warning',
    risk_score: 5,
    detection: /.*/,  // Applies to all drugs
    check: (rx) => {
      const days = parseInt(rx.days_supply) || 0;
      const qty = parseFloat(rx.quantity_dispensed) || 0;
      const sig = (rx.sig || '').toLowerCase();

      if (!days || !qty || !sig) return { violation: false };

      // Calculate expected daily dose from SIG
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

  // Controlled Substance Missing NPI
  CONTROLLED_MISSING_NPI: {
    name: 'Controlled Substance Missing Prescriber NPI',
    rule_type: 'missing_npi',
    severity: 'critical',
    risk_score: 9,
    // Common controlled substances
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
  }
};

// ============================================
// EARLY REFILL DETECTION
// ============================================

async function checkEarlyRefills(pharmacyId, lookbackDays = 90) {
  const flags = [];

  // Get all prescriptions with previous fill info
  const result = await pool.query(`
    WITH refill_data AS (
      SELECT
        prescription_id,
        patient_id,
        drug_name,
        ndc,
        quantity_dispensed,
        days_supply,
        dispensed_date,
        insurance_bin,
        prescriber_name,
        LAG(dispensed_date) OVER (
          PARTITION BY patient_id,
            CASE
              WHEN drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS|SEMAGLUTIDE' THEN 'SEMAGLUTIDE'
              WHEN drug_name ~* 'MOUNJARO|ZEPBOUND|TIRZEPATIDE' THEN 'TIRZEPATIDE'
              WHEN drug_name ~* 'VICTOZA|SAXENDA|LIRAGLUTIDE' THEN 'LIRAGLUTIDE'
              WHEN drug_name ~* 'TRULICITY|DULAGLUTIDE' THEN 'DULAGLUTIDE'
              ELSE SUBSTRING(drug_name FROM 1 FOR 10)
            END
          ORDER BY dispensed_date
        ) as prev_fill_date,
        LAG(days_supply) OVER (
          PARTITION BY patient_id,
            CASE
              WHEN drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS|SEMAGLUTIDE' THEN 'SEMAGLUTIDE'
              WHEN drug_name ~* 'MOUNJARO|ZEPBOUND|TIRZEPATIDE' THEN 'TIRZEPATIDE'
              WHEN drug_name ~* 'VICTOZA|SAXENDA|LIRAGLUTIDE' THEN 'LIRAGLUTIDE'
              WHEN drug_name ~* 'TRULICITY|DULAGLUTIDE' THEN 'DULAGLUTIDE'
              ELSE SUBSTRING(drug_name FROM 1 FOR 10)
            END
          ORDER BY dispensed_date
        ) as prev_days_supply
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND dispensed_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
        AND drug_name ~* 'OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE'
    )
    SELECT * FROM refill_data
    WHERE prev_fill_date IS NOT NULL
  `, [pharmacyId, lookbackDays]);

  for (const rx of result.rows) {
    const daysBetween = Math.floor(
      (new Date(rx.dispensed_date) - new Date(rx.prev_fill_date)) / (1000 * 60 * 60 * 24)
    );
    const expectedDays = parseInt(rx.prev_days_supply) || 28;
    const daysEarly = expectedDays - daysBetween;

    if (daysEarly > 7 && daysBetween > 0) {
      flags.push({
        prescription_id: rx.prescription_id,
        patient_id: rx.patient_id,
        drug_name: rx.drug_name,
        ndc: rx.ndc,
        quantity_dispensed: rx.quantity_dispensed,
        days_supply: rx.days_supply,
        dispensed_date: rx.dispensed_date,
        rule_code: 'GLP1_EARLY_REFILL',
        rule_type: 'early_refill',
        severity: 'warning',
        risk_score: 7,
        violation_message: `Early refill: ${rx.drug_name} filled ${daysEarly} days early (${daysBetween} days since last fill, expected ${expectedDays})`,
        expected_value: `>${expectedDays - 7} days`,
        actual_value: `${daysBetween} days`
      });
    }
  }

  return flags;
}

// ============================================
// DUPLICATE THERAPY DETECTION
// ============================================

async function checkDuplicateTherapy(pharmacyId, lookbackDays = 90) {
  const flags = [];

  const result = await pool.query(`
    WITH patient_glp1 AS (
      SELECT
        patient_id,
        ARRAY_AGG(DISTINCT prescription_id ORDER BY prescription_id) as prescription_ids,
        ARRAY_AGG(DISTINCT
          CASE
            WHEN drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS' THEN 'SEMAGLUTIDE'
            WHEN drug_name ~* 'MOUNJARO|ZEPBOUND' THEN 'TIRZEPATIDE'
            WHEN drug_name ~* 'VICTOZA|SAXENDA' THEN 'LIRAGLUTIDE'
            WHEN drug_name ~* 'TRULICITY' THEN 'DULAGLUTIDE'
            WHEN drug_name ~* 'BYETTA|BYDUREON' THEN 'EXENATIDE'
            ELSE 'OTHER'
          END
        ) as glp1_classes,
        ARRAY_AGG(DISTINCT drug_name) as drugs,
        MAX(dispensed_date) as last_fill
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND drug_name ~* 'OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|BYETTA|BYDUREON|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE|EXENATIDE'
        AND dispensed_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      GROUP BY patient_id
      HAVING COUNT(DISTINCT
        CASE
          WHEN drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS' THEN 'SEMAGLUTIDE'
          WHEN drug_name ~* 'MOUNJARO|ZEPBOUND' THEN 'TIRZEPATIDE'
          WHEN drug_name ~* 'VICTOZA|SAXENDA' THEN 'LIRAGLUTIDE'
          WHEN drug_name ~* 'TRULICITY' THEN 'DULAGLUTIDE'
          WHEN drug_name ~* 'BYETTA|BYDUREON' THEN 'EXENATIDE'
          ELSE 'OTHER'
        END
      ) > 1
    )
    SELECT * FROM patient_glp1
  `, [pharmacyId, lookbackDays]);

  for (const row of result.rows) {
    flags.push({
      prescription_id: row.prescription_ids[0],
      patient_id: row.patient_id,
      drug_name: row.drugs.join(', '),
      rule_code: 'GLP1_DUPLICATE_THERAPY',
      rule_type: 'duplicate_therapy',
      severity: 'critical',
      risk_score: 9,
      violation_message: `Duplicate GLP-1 therapy: Patient receiving ${row.glp1_classes.join(' and ')} (${row.drugs.join(', ')})`,
      expected_value: '1 GLP-1 class',
      actual_value: `${row.glp1_classes.length} classes`,
      dispensed_date: row.last_fill
    });
  }

  return flags;
}

// ============================================
// MAIN SCANNER
// ============================================

async function runAuditScanner(pharmacyId, options = {}) {
  const { lookbackDays = 90, clearExisting = true } = options;

  console.log(`\n🔍 Running Audit Scanner for pharmacy ${pharmacyId}...\n`);
  console.log(`   Lookback: ${lookbackDays} days`);

  // Get pharmacy info
  const pharmacyResult = await pool.query(`
    SELECT p.pharmacy_name, c.client_name
    FROM pharmacies p
    JOIN clients c ON c.client_id = p.client_id
    WHERE p.pharmacy_id = $1
  `, [pharmacyId]);

  if (pharmacyResult.rows.length === 0) {
    throw new Error(`Pharmacy not found: ${pharmacyId}`);
  }

  console.log(`   Pharmacy: ${pharmacyResult.rows[0].pharmacy_name}\n`);

  // Load audit rules from database
  const rulesResult = await pool.query(`
    SELECT rule_id, rule_code, rule_name, rule_type, drug_keywords, severity, audit_risk_score
    FROM audit_rules
    WHERE is_enabled = true
  `);

  console.log(`   Loaded ${rulesResult.rows.length} database audit rules`);
  console.log(`   Using ${Object.keys(AUDIT_RULES).length} built-in audit rules\n`);

  // Get prescriptions
  const rxResult = await pool.query(`
    SELECT
      prescription_id,
      patient_id,
      drug_name,
      ndc,
      quantity_dispensed,
      days_supply,
      daw_code,
      sig,
      dispensed_date,
      prescriber_name,
      prescriber_npi,
      insurance_bin,
      insurance_group,
      patient_pay,
      insurance_pay,
      acquisition_cost
    FROM prescriptions
    WHERE pharmacy_id = $1
      AND dispensed_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
    ORDER BY dispensed_date DESC
  `, [pharmacyId, lookbackDays]);

  console.log(`   Found ${rxResult.rows.length} prescriptions to audit\n`);

  const allFlags = [];

  // Run each built-in rule
  for (const [ruleCode, rule] of Object.entries(AUDIT_RULES)) {
    let matchCount = 0;
    let flagCount = 0;

    for (const rx of rxResult.rows) {
      // Check if drug matches this rule's detection pattern
      if (!rule.detection.test(rx.drug_name)) continue;
      matchCount++;

      // Run the check
      const result = rule.check(rx);

      if (result.violation) {
        flagCount++;
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

    if (flagCount > 0) {
      console.log(`   ✓ ${ruleCode}: ${flagCount} flags (from ${matchCount} matches)`);
    }
  }

  // Run early refill detection
  console.log('\n   Checking early refills...');
  const earlyRefillFlags = await checkEarlyRefills(pharmacyId, lookbackDays);
  if (earlyRefillFlags.length > 0) {
    console.log(`   ✓ GLP1_EARLY_REFILL: ${earlyRefillFlags.length} flags`);
    allFlags.push(...earlyRefillFlags);
  }

  // Run duplicate therapy detection
  console.log('   Checking duplicate therapy...');
  const duplicateFlags = await checkDuplicateTherapy(pharmacyId, lookbackDays);
  if (duplicateFlags.length > 0) {
    console.log(`   ✓ GLP1_DUPLICATE_THERAPY: ${duplicateFlags.length} flags`);
    allFlags.push(...duplicateFlags);
  }

  console.log(`\n💾 Saving ${allFlags.length} audit flags to database...`);

  // Clear existing open flags if requested
  if (clearExisting) {
    const deleteResult = await pool.query(`
      DELETE FROM audit_flags
      WHERE pharmacy_id = $1 AND status = 'open'
    `, [pharmacyId]);
    console.log(`   Cleared ${deleteResult.rowCount} existing open flags`);
  }

  // Get rule IDs from database for linking
  const ruleIdMap = new Map();
  for (const dbRule of rulesResult.rows) {
    ruleIdMap.set(dbRule.rule_code, dbRule.rule_id);
  }

  // Insert flags
  let inserted = 0;
  let errors = 0;

  for (const flag of allFlags) {
    try {
      await pool.query(`
        INSERT INTO audit_flags (
          flag_id, pharmacy_id, patient_id, prescription_id, rule_id,
          rule_type, severity, drug_name, ndc, dispensed_quantity,
          days_supply, daw_code, gross_profit, violation_message,
          expected_value, actual_value, dispensed_date, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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
      inserted++;
    } catch (error) {
      errors++;
      if (errors <= 3) {
        console.error(`   Error: ${error.message}`);
      }
    }
  }

  // Get summary
  const summary = await pool.query(`
    SELECT
      severity,
      COUNT(*) as count
    FROM audit_flags
    WHERE pharmacy_id = $1 AND status = 'open'
    GROUP BY severity
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 1
        WHEN 'warning' THEN 2
        ELSE 3
      END
  `, [pharmacyId]);

  console.log(`\n✅ Audit scan complete!`);
  console.log(`   📊 Flags created: ${inserted}`);
  if (errors > 0) console.log(`   ⚠️ Errors: ${errors}`);
  console.log(`\n   Summary by severity:`);
  for (const row of summary.rows) {
    const icon = row.severity === 'critical' ? '🔴' : row.severity === 'warning' ? '🟡' : '🔵';
    console.log(`   ${icon} ${row.severity}: ${row.count}`);
  }

  return { inserted, errors, summary: summary.rows };
}

// ============================================
// SCAN ALL PHARMACIES
// ============================================

async function scanAllPharmacies(options = {}) {
  const { lookbackDays = 90 } = options;

  console.log('\n🏥 Scanning ALL pharmacies...\n');

  const pharmacies = await pool.query(`
    SELECT p.pharmacy_id, p.pharmacy_name, c.client_name
    FROM pharmacies p
    JOIN clients c ON c.client_id = p.client_id
    WHERE c.status = 'active'
    ORDER BY p.pharmacy_name
  `);

  console.log(`Found ${pharmacies.rows.length} active pharmacies\n`);

  const results = [];

  for (const pharmacy of pharmacies.rows) {
    try {
      console.log(`\n${'='.repeat(60)}`);
      const result = await runAuditScanner(pharmacy.pharmacy_id, { lookbackDays });
      results.push({ pharmacy_id: pharmacy.pharmacy_id, name: pharmacy.pharmacy_name, ...result });
    } catch (error) {
      console.error(`   ❌ Failed: ${error.message}`);
      results.push({ pharmacy_id: pharmacy.pharmacy_id, name: pharmacy.pharmacy_name, error: error.message });
    }
  }

  // Print grand totals
  console.log(`\n${'='.repeat(60)}`);
  console.log('GRAND TOTAL');
  console.log('='.repeat(60));

  const totalFlags = results.reduce((sum, r) => sum + (r.inserted || 0), 0);
  const totalErrors = results.reduce((sum, r) => sum + (r.errors || 0), 0);
  const failedPharmacies = results.filter(r => r.error).length;

  console.log(`   Pharmacies scanned: ${pharmacies.rows.length}`);
  console.log(`   Total flags created: ${totalFlags}`);
  if (totalErrors > 0) console.log(`   Total errors: ${totalErrors}`);
  if (failedPharmacies > 0) console.log(`   Failed pharmacies: ${failedPharmacies}`);

  return results;
}

// ============================================
// CLI
// ============================================

const args = process.argv.slice(2);

async function main() {
  try {
    if (args.includes('--all')) {
      const lookbackDays = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1]) || 90;
      await scanAllPharmacies({ lookbackDays });
    } else if (args.length >= 1 && !args[0].startsWith('--')) {
      const clientEmail = args[0];
      const lookbackDays = parseInt(args.find(a => a.startsWith('--days='))?.split('=')[1]) || 90;

      // Get pharmacy ID from email
      const result = await pool.query(`
        SELECT p.pharmacy_id
        FROM clients c
        JOIN pharmacies p ON p.client_id = c.client_id
        WHERE c.submitter_email = $1
      `, [clientEmail.toLowerCase()]);

      if (result.rows.length === 0) {
        throw new Error(`Client not found: ${clientEmail}`);
      }

      await runAuditScanner(result.rows[0].pharmacy_id, { lookbackDays });
    } else {
      console.log('\nUsage:');
      console.log('  node run-audit-triggers.js <client-email> [--days=90]');
      console.log('  node run-audit-triggers.js --all [--days=90]');
      console.log('\nExamples:');
      console.log('  node run-audit-triggers.js contact@mybravorx.com');
      console.log('  node run-audit-triggers.js --all --days=30');
      process.exit(1);
    }

    console.log('\n🎉 Done!\n');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Scanner failed:', error.message);
    process.exit(1);
  }
}

main();
