/**
 * GLP-1 Dispensing Anomaly Analysis Script
 * Scans the data warehouse for GLP-1 prescriptions and identifies dispensing anomalies
 */

import 'dotenv/config';
import { query, pool } from './src/database/index.js';

// GLP-1 drugs with expected dispensing parameters
const GLP1_DRUGS = {
  // Semaglutide products
  'OZEMPIC': { expectedQty: [1, 1.5, 3], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable - 0.25mg, 0.5mg, 1mg, 2mg pens' },
  'WEGOVY': { expectedQty: [0.25, 0.5, 1, 1.7, 2.4], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable - weight management' },
  'RYBELSUS': { expectedQty: [30, 90], expectedDays: [30, 90], packageSize: 'tablet', notes: 'Oral semaglutide - 3mg, 7mg, 14mg' },

  // Tirzepatide products
  'MOUNJARO': { expectedQty: [2, 4], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable - 2.5mg to 15mg pens' },
  'ZEPBOUND': { expectedQty: [2, 4], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable - weight management' },

  // Liraglutide products
  'VICTOZA': { expectedQty: [2, 3], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable - 18mg/3ml pens' },
  'SAXENDA': { expectedQty: [5], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable - weight management, 5 pens/box' },

  // Dulaglutide
  'TRULICITY': { expectedQty: [4], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable - 4 single-dose pens per box' },

  // Exenatide products
  'BYETTA': { expectedQty: [1, 2.4], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable BID' },
  'BYDUREON': { expectedQty: [4], expectedDays: [28, 30], packageSize: 'pen', notes: 'Injectable weekly - 4 pens per box' }
};

// Convert GLP-1 drug names to regex pattern
const GLP1_PATTERN = Object.keys(GLP1_DRUGS).join('|') + '|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE|EXENATIDE';

async function analyzeGLP1Anomalies() {
  console.log('='.repeat(80));
  console.log('GLP-1 DISPENSING ANOMALY ANALYSIS');
  console.log('='.repeat(80));
  console.log('');

  const anomalies = {
    quantityAnomalies: [],
    daysSupplyAnomalies: [],
    earlyRefills: [],
    unusualPrescribers: [],
    negativeProfitClaims: [],
    dawCodeIssues: [],
    highQuantityClaims: [],
    duplicateTherapy: [],
    compoundingRisks: []
  };

  try {
    // 1. Get all GLP-1 prescriptions
    console.log('Fetching GLP-1 prescriptions...\n');
    const glp1Rx = await query(`
      SELECT
        prescription_id,
        pharmacy_id,
        patient_id,
        rx_number,
        drug_name,
        ndc,
        quantity_dispensed as quantity,
        days_supply,
        daw_code,
        dispensed_date,
        prescriber_name,
        prescriber_npi,
        insurance_bin as bin,
        insurance_pcn as pcn,
        insurance_group as group_number,
        (COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as gross_profit,
        raw_data,
        created_at
      FROM prescriptions
      WHERE drug_name ~* $1
      ORDER BY dispensed_date DESC
    `, [GLP1_PATTERN]);

    console.log(`Found ${glp1Rx.rows.length} GLP-1 prescriptions\n`);

    if (glp1Rx.rows.length === 0) {
      console.log('No GLP-1 prescriptions found in database.');
      return anomalies;
    }

    // 2. Analyze each prescription for anomalies
    console.log('-'.repeat(80));
    console.log('ANOMALY DETECTION');
    console.log('-'.repeat(80));

    for (const rx of glp1Rx.rows) {
      const drugKey = Object.keys(GLP1_DRUGS).find(key =>
        rx.drug_name?.toUpperCase().includes(key)
      );
      const drugInfo = drugKey ? GLP1_DRUGS[drugKey] : null;
      const rawData = rx.raw_data || {};

      // 2a. Quantity anomalies
      if (drugInfo && rx.quantity) {
        const qty = parseFloat(rx.quantity);
        const isValidQty = drugInfo.expectedQty.some(expected =>
          Math.abs(qty - expected) < 0.1 || qty % expected === 0
        );

        if (!isValidQty && qty > 0) {
          anomalies.quantityAnomalies.push({
            drug: rx.drug_name,
            ndc: rx.ndc,
            quantity: qty,
            expectedQty: drugInfo.expectedQty,
            rx_number: rx.rx_number,
            dispensed_date: rx.dispensed_date,
            prescriber: rx.prescriber_name,
            reason: `Unexpected quantity ${qty} for ${drugKey} (expected: ${drugInfo.expectedQty.join(' or ')})`
          });
        }
      }

      // 2b. Days supply anomalies
      if (drugInfo && rx.days_supply) {
        const days = parseInt(rx.days_supply);
        const isValidDays = drugInfo.expectedDays.some(expected =>
          Math.abs(days - expected) <= 2
        );

        if (!isValidDays && days > 0 && days < 84) {
          anomalies.daysSupplyAnomalies.push({
            drug: rx.drug_name,
            days_supply: days,
            expectedDays: drugInfo.expectedDays,
            rx_number: rx.rx_number,
            dispensed_date: rx.dispensed_date,
            reason: `Unusual days supply ${days} for ${drugKey || rx.drug_name}`
          });
        }
      }

      // 2c. Negative or very low profit claims
      if (rx.gross_profit !== null) {
        const gp = parseFloat(rx.gross_profit);
        if (gp < 0) {
          anomalies.negativeProfitClaims.push({
            drug: rx.drug_name,
            gross_profit: gp,
            rx_number: rx.rx_number,
            dispensed_date: rx.dispensed_date,
            bin: rx.bin,
            group: rx.group_number,
            reason: 'Negative gross profit - potential reimbursement issue'
          });
        }
      }

      // 2d. High quantity claims (potential diversion risk)
      const qty = parseFloat(rx.quantity) || 0;
      if (qty > 10) {
        anomalies.highQuantityClaims.push({
          drug: rx.drug_name,
          quantity: qty,
          days_supply: rx.days_supply,
          rx_number: rx.rx_number,
          dispensed_date: rx.dispensed_date,
          reason: `High quantity ${qty} - potential diversion or data entry error`
        });
      }

      // 2e. DAW code issues (if available)
      const dawCode = rx.daw_code;
      if (dawCode && parseInt(dawCode) > 0) {
        anomalies.dawCodeIssues.push({
          drug: rx.drug_name,
          daw_code: dawCode,
          rx_number: rx.rx_number,
          dispensed_date: rx.dispensed_date,
          reason: `DAW code ${dawCode} on GLP-1 - most GLP-1s have no generic`
        });
      }
    }

    // 3. Check for early refills (patient-level analysis)
    console.log('\nAnalyzing refill patterns...');
    const patientRefills = await query(`
      SELECT
        patient_id,
        drug_name,
        rx_number,
        dispensed_date,
        days_supply,
        LAG(dispensed_date) OVER (PARTITION BY patient_id,
          CASE
            WHEN drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS|SEMAGLUTIDE' THEN 'SEMAGLUTIDE'
            WHEN drug_name ~* 'MOUNJARO|ZEPBOUND|TIRZEPATIDE' THEN 'TIRZEPATIDE'
            WHEN drug_name ~* 'VICTOZA|SAXENDA|LIRAGLUTIDE' THEN 'LIRAGLUTIDE'
            WHEN drug_name ~* 'TRULICITY|DULAGLUTIDE' THEN 'DULAGLUTIDE'
            WHEN drug_name ~* 'BYETTA|BYDUREON|EXENATIDE' THEN 'EXENATIDE'
            ELSE drug_name
          END
          ORDER BY dispensed_date) as prev_fill_date,
        LAG(days_supply) OVER (PARTITION BY patient_id,
          CASE
            WHEN drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS|SEMAGLUTIDE' THEN 'SEMAGLUTIDE'
            WHEN drug_name ~* 'MOUNJARO|ZEPBOUND|TIRZEPATIDE' THEN 'TIRZEPATIDE'
            WHEN drug_name ~* 'VICTOZA|SAXENDA|LIRAGLUTIDE' THEN 'LIRAGLUTIDE'
            WHEN drug_name ~* 'TRULICITY|DULAGLUTIDE' THEN 'DULAGLUTIDE'
            WHEN drug_name ~* 'BYETTA|BYDUREON|EXENATIDE' THEN 'EXENATIDE'
            ELSE drug_name
          END
          ORDER BY dispensed_date) as prev_days_supply
      FROM prescriptions
      WHERE drug_name ~* $1
      ORDER BY patient_id, dispensed_date
    `, [GLP1_PATTERN]);

    for (const rx of patientRefills.rows) {
      if (rx.prev_fill_date && rx.prev_days_supply) {
        const daysBetween = Math.floor(
          (new Date(rx.dispensed_date) - new Date(rx.prev_fill_date)) / (1000 * 60 * 60 * 24)
        );
        const expectedDays = parseInt(rx.prev_days_supply);

        // Early refill if filled more than 7 days early
        if (daysBetween < expectedDays - 7 && daysBetween > 0) {
          anomalies.earlyRefills.push({
            patient_id: rx.patient_id,
            drug: rx.drug_name,
            dispensed_date: rx.dispensed_date,
            prev_fill_date: rx.prev_fill_date,
            days_between: daysBetween,
            expected_days: expectedDays,
            days_early: expectedDays - daysBetween,
            reason: `Filled ${expectedDays - daysBetween} days early`
          });
        }
      }
    }

    // 4. Check for duplicate GLP-1 therapy (patient on multiple GLP-1s)
    console.log('Checking for duplicate GLP-1 therapy...');
    const duplicateTherapy = await query(`
      WITH patient_glp1 AS (
        SELECT
          rx.patient_id,
          p.first_name,
          p.last_name,
          ARRAY_AGG(DISTINCT
            CASE
              WHEN rx.drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS' THEN 'SEMAGLUTIDE'
              WHEN rx.drug_name ~* 'MOUNJARO|ZEPBOUND' THEN 'TIRZEPATIDE'
              WHEN rx.drug_name ~* 'VICTOZA|SAXENDA' THEN 'LIRAGLUTIDE'
              WHEN rx.drug_name ~* 'TRULICITY' THEN 'DULAGLUTIDE'
              WHEN rx.drug_name ~* 'BYETTA|BYDUREON' THEN 'EXENATIDE'
              ELSE 'OTHER_GLP1'
            END
          ) as glp1_classes,
          ARRAY_AGG(DISTINCT rx.drug_name) as drugs
        FROM prescriptions rx
        LEFT JOIN patients p ON rx.patient_id = p.patient_id
        WHERE rx.drug_name ~* $1
          AND rx.dispensed_date >= CURRENT_DATE - INTERVAL '90 days'
        GROUP BY rx.patient_id, p.first_name, p.last_name
        HAVING COUNT(DISTINCT
          CASE
            WHEN rx.drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS' THEN 'SEMAGLUTIDE'
            WHEN rx.drug_name ~* 'MOUNJARO|ZEPBOUND' THEN 'TIRZEPATIDE'
            WHEN rx.drug_name ~* 'VICTOZA|SAXENDA' THEN 'LIRAGLUTIDE'
            WHEN rx.drug_name ~* 'TRULICITY' THEN 'DULAGLUTIDE'
            WHEN rx.drug_name ~* 'BYETTA|BYDUREON' THEN 'EXENATIDE'
            ELSE 'OTHER_GLP1'
          END
        ) > 1
      )
      SELECT * FROM patient_glp1
    `, [GLP1_PATTERN]);

    for (const patient of duplicateTherapy.rows) {
      anomalies.duplicateTherapy.push({
        patient_id: patient.patient_id,
        patient_name: `${patient.first_name} ${patient.last_name}`,
        glp1_classes: patient.glp1_classes,
        drugs: patient.drugs,
        reason: 'Patient on multiple GLP-1 classes simultaneously'
      });
    }

    // 5. Check for compounding pharmacy indicators
    console.log('Checking for compounding indicators...');
    const compoundingCheck = await query(`
      SELECT
        drug_name,
        ndc,
        COUNT(*) as claim_count,
        ARRAY_AGG(DISTINCT pharmacy_id) as pharmacies
      FROM prescriptions
      WHERE drug_name ~* 'SEMAGLUTIDE|TIRZEPATIDE'
        AND (
          drug_name ~* 'COMPOUND|COMPOUNDED|TROCHE|SUBLINGUAL|ORAL'
          OR ndc IS NULL
          OR ndc = ''
          OR LENGTH(ndc) < 11
        )
      GROUP BY drug_name, ndc
    `, []);

    for (const row of compoundingCheck.rows) {
      anomalies.compoundingRisks.push({
        drug: row.drug_name,
        ndc: row.ndc || 'MISSING',
        claim_count: row.claim_count,
        reason: 'Potential compounded GLP-1 - regulatory/audit risk'
      });
    }

    // 6. Unusual prescriber patterns
    console.log('Analyzing prescriber patterns...');
    const prescriberAnalysis = await query(`
      SELECT
        prescriber_name,
        prescriber_npi,
        COUNT(*) as rx_count,
        COUNT(DISTINCT patient_id) as patient_count,
        ARRAY_AGG(DISTINCT drug_name) as drugs,
        AVG(quantity_dispensed::numeric) as avg_quantity
      FROM prescriptions
      WHERE drug_name ~* $1
        AND dispensed_date >= CURRENT_DATE - INTERVAL '90 days'
      GROUP BY prescriber_name, prescriber_npi
      HAVING COUNT(*) > 10
      ORDER BY rx_count DESC
      LIMIT 20
    `, [GLP1_PATTERN]);

    for (const prescriber of prescriberAnalysis.rows) {
      const rxPerPatient = prescriber.rx_count / prescriber.patient_count;
      // Flag if prescriber has unusually high Rx per patient ratio
      if (rxPerPatient > 5 || prescriber.avg_quantity > 8) {
        anomalies.unusualPrescribers.push({
          prescriber: prescriber.prescriber_name,
          npi: prescriber.prescriber_npi,
          rx_count: prescriber.rx_count,
          patient_count: prescriber.patient_count,
          rx_per_patient: rxPerPatient.toFixed(2),
          avg_quantity: parseFloat(prescriber.avg_quantity).toFixed(2),
          drugs: prescriber.drugs,
          reason: rxPerPatient > 5 ? 'High Rx/patient ratio' : 'High average quantity'
        });
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(80));
    console.log('ANOMALY SUMMARY');
    console.log('='.repeat(80));

    console.log(`\n1. QUANTITY ANOMALIES: ${anomalies.quantityAnomalies.length}`);
    anomalies.quantityAnomalies.slice(0, 10).forEach(a => {
      console.log(`   - ${a.drug}: Qty ${a.quantity} (expected ${a.expectedQty.join('/')}) - ${a.dispensed_date}`);
    });

    console.log(`\n2. DAYS SUPPLY ANOMALIES: ${anomalies.daysSupplyAnomalies.length}`);
    anomalies.daysSupplyAnomalies.slice(0, 10).forEach(a => {
      console.log(`   - ${a.drug}: ${a.days_supply} days (expected ${a.expectedDays.join('/')}) - ${a.dispensed_date}`);
    });

    console.log(`\n3. EARLY REFILLS: ${anomalies.earlyRefills.length}`);
    anomalies.earlyRefills.slice(0, 10).forEach(a => {
      console.log(`   - ${a.drug}: ${a.days_early} days early (patient ${a.patient_id?.slice(0,8)}...)`);
    });

    console.log(`\n4. NEGATIVE PROFIT CLAIMS: ${anomalies.negativeProfitClaims.length}`);
    anomalies.negativeProfitClaims.slice(0, 10).forEach(a => {
      console.log(`   - ${a.drug}: $${a.gross_profit} (BIN: ${a.bin}) - ${a.dispensed_date}`);
    });

    console.log(`\n5. HIGH QUANTITY CLAIMS: ${anomalies.highQuantityClaims.length}`);
    anomalies.highQuantityClaims.slice(0, 10).forEach(a => {
      console.log(`   - ${a.drug}: Qty ${a.quantity} - ${a.dispensed_date}`);
    });

    console.log(`\n6. DAW CODE ISSUES: ${anomalies.dawCodeIssues.length}`);
    anomalies.dawCodeIssues.slice(0, 10).forEach(a => {
      console.log(`   - ${a.drug}: DAW ${a.daw_code} - ${a.dispensed_date}`);
    });

    console.log(`\n7. DUPLICATE GLP-1 THERAPY: ${anomalies.duplicateTherapy.length}`);
    anomalies.duplicateTherapy.slice(0, 10).forEach(a => {
      console.log(`   - ${a.patient_name}: ${a.drugs.join(', ')}`);
    });

    console.log(`\n8. COMPOUNDING RISKS: ${anomalies.compoundingRisks.length}`);
    anomalies.compoundingRisks.slice(0, 10).forEach(a => {
      console.log(`   - ${a.drug}: ${a.claim_count} claims (NDC: ${a.ndc})`);
    });

    console.log(`\n9. UNUSUAL PRESCRIBERS: ${anomalies.unusualPrescribers.length}`);
    anomalies.unusualPrescribers.slice(0, 10).forEach(a => {
      console.log(`   - ${a.prescriber}: ${a.rx_count} Rx, ${a.patient_count} patients (${a.rx_per_patient} Rx/patient)`);
    });

    return anomalies;

  } catch (error) {
    console.error('Error analyzing GLP-1 anomalies:', error);
    throw error;
  }
}

// Generate audit trigger recommendations based on anomalies
function generateTriggerRecommendations(anomalies) {
  console.log('\n' + '='.repeat(80));
  console.log('RECOMMENDED AUDIT TRIGGERS');
  console.log('='.repeat(80));

  const triggers = [];

  // Trigger 1: GLP-1 Quantity Validation
  if (anomalies.quantityAnomalies.length > 0) {
    triggers.push({
      trigger_id: 'GLP1_QTY_VALIDATION',
      name: 'GLP-1 Quantity Validation',
      description: 'Flags GLP-1 claims with unexpected quantities',
      trigger_type: 'AUDIT',
      severity: 'HIGH',
      risk_score: 8,
      detection_keywords: ['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS'],
      rule_logic: 'CHECK quantity != expected_package_size',
      expected_values: {
        'OZEMPIC': [1, 1.5, 3],
        'WEGOVY': [0.25, 0.5, 1, 1.7, 2.4],
        'MOUNJARO': [2, 4],
        'ZEPBOUND': [2, 4],
        'TRULICITY': [4],
        'VICTOZA': [2, 3],
        'SAXENDA': [5],
        'RYBELSUS': [30, 90]
      }
    });
  }

  // Trigger 2: GLP-1 Early Refill Detection
  if (anomalies.earlyRefills.length > 0) {
    triggers.push({
      trigger_id: 'GLP1_EARLY_REFILL',
      name: 'GLP-1 Early Refill Alert',
      description: 'Detects GLP-1 refills more than 7 days before expected',
      trigger_type: 'AUDIT',
      severity: 'MEDIUM',
      risk_score: 6,
      detection_keywords: ['SEMAGLUTIDE', 'TIRZEPATIDE', 'LIRAGLUTIDE', 'DULAGLUTIDE', 'EXENATIDE'],
      rule_logic: 'CHECK days_since_last_fill < (previous_days_supply - 7)',
      threshold_days_early: 7
    });
  }

  // Trigger 3: Duplicate GLP-1 Therapy
  if (anomalies.duplicateTherapy.length > 0) {
    triggers.push({
      trigger_id: 'GLP1_DUPLICATE_THERAPY',
      name: 'Duplicate GLP-1 Therapy Alert',
      description: 'Patient receiving multiple GLP-1 medications simultaneously',
      trigger_type: 'AUDIT',
      severity: 'CRITICAL',
      risk_score: 9,
      detection_keywords: ['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS', 'BYETTA', 'BYDUREON'],
      rule_logic: 'CHECK patient_has_multiple_glp1_classes_in_90_days',
      lookback_days: 90
    });
  }

  // Trigger 4: GLP-1 Compounding Alert
  triggers.push({
    trigger_id: 'GLP1_COMPOUNDING_ALERT',
    name: 'GLP-1 Compounding Risk Alert',
    description: 'Flags potential compounded GLP-1 products (regulatory risk)',
    trigger_type: 'AUDIT',
    severity: 'CRITICAL',
    risk_score: 10,
    detection_keywords: ['SEMAGLUTIDE COMPOUND', 'TIRZEPATIDE COMPOUND', 'COMPOUNDED SEMAGLUTIDE', 'COMPOUNDED TIRZEPATIDE'],
    rule_logic: 'CHECK drug_name CONTAINS "COMPOUND" OR ndc IS NULL/INVALID',
    notes: 'FDA has issued warnings about compounded semaglutide/tirzepatide products'
  });

  // Trigger 5: GLP-1 Negative Margin Alert
  if (anomalies.negativeProfitClaims.length > 0) {
    triggers.push({
      trigger_id: 'GLP1_NEGATIVE_MARGIN',
      name: 'GLP-1 Negative Margin Alert',
      description: 'GLP-1 claims with negative gross profit',
      trigger_type: 'AUDIT',
      severity: 'HIGH',
      risk_score: 7,
      detection_keywords: ['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS'],
      rule_logic: 'CHECK gross_profit < 0',
      notes: 'Review contract pricing and acquisition costs'
    });
  }

  // Trigger 6: High Quantity GLP-1 Alert
  if (anomalies.highQuantityClaims.length > 0) {
    triggers.push({
      trigger_id: 'GLP1_HIGH_QUANTITY',
      name: 'GLP-1 High Quantity Alert',
      description: 'GLP-1 claims with unusually high quantities (potential diversion)',
      trigger_type: 'AUDIT',
      severity: 'CRITICAL',
      risk_score: 9,
      detection_keywords: ['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'SEMAGLUTIDE', 'TIRZEPATIDE'],
      rule_logic: 'CHECK quantity > 10',
      threshold_quantity: 10
    });
  }

  // Trigger 7: GLP-1 Days Supply Mismatch
  if (anomalies.daysSupplyAnomalies.length > 0) {
    triggers.push({
      trigger_id: 'GLP1_DAYS_SUPPLY_MISMATCH',
      name: 'GLP-1 Days Supply Validation',
      description: 'GLP-1 claims with non-standard days supply',
      trigger_type: 'AUDIT',
      severity: 'MEDIUM',
      risk_score: 5,
      detection_keywords: ['OZEMPIC', 'WEGOVY', 'MOUNJARO', 'ZEPBOUND', 'TRULICITY', 'VICTOZA', 'SAXENDA', 'RYBELSUS'],
      rule_logic: 'CHECK days_supply NOT IN (28, 30, 84, 90)',
      expected_days: [28, 30, 84, 90]
    });
  }

  // Trigger 8: Weight Loss vs Diabetes GLP-1 Mismatch
  triggers.push({
    trigger_id: 'GLP1_INDICATION_MISMATCH',
    name: 'GLP-1 Indication Check',
    description: 'Weight loss GLP-1 (Wegovy/Zepbound) dispensed to diabetic patient on diabetes GLP-1',
    trigger_type: 'AUDIT',
    severity: 'HIGH',
    risk_score: 7,
    detection_keywords: ['WEGOVY', 'ZEPBOUND'],
    if_has: ['OZEMPIC', 'MOUNJARO', 'TRULICITY', 'VICTOZA'],
    rule_logic: 'Patient on both weight loss AND diabetes GLP-1 formulations',
    notes: 'Should not be on both Ozempic and Wegovy simultaneously'
  });

  // Print recommendations
  console.log('\n');
  triggers.forEach((t, i) => {
    console.log(`${i + 1}. ${t.trigger_id}`);
    console.log(`   Name: ${t.name}`);
    console.log(`   Severity: ${t.severity} (Risk Score: ${t.risk_score})`);
    console.log(`   Logic: ${t.rule_logic}`);
    console.log(`   Keywords: ${t.detection_keywords.slice(0, 5).join(', ')}...`);
    console.log('');
  });

  return triggers;
}

// Main execution
async function main() {
  try {
    const anomalies = await analyzeGLP1Anomalies();
    const triggers = generateTriggerRecommendations(anomalies);

    console.log('\n' + '='.repeat(80));
    console.log('ANALYSIS COMPLETE');
    console.log('='.repeat(80));
    console.log(`\nTotal Anomalies Found: ${
      Object.values(anomalies).reduce((sum, arr) => sum + arr.length, 0)
    }`);
    console.log(`Recommended Triggers: ${triggers.length}`);

    // Export results for further processing
    return { anomalies, triggers };

  } catch (error) {
    console.error('Analysis failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
