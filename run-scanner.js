// TheRxOS V2 - Opportunity Scanner Runner
// Run with: node run-scanner.js <client-email>
// Example: node run-scanner.js contact@mybravorx.com

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ============================================
// OPPORTUNITY SCANNER ENGINES
// ============================================

/**
 * NDC Optimization Engine
 * Finds cases where a lower-cost NDC exists for the same drug
 */
async function scanNDCOptimizations(pharmacyId) {
  console.log('   🔍 Scanning for NDC optimizations...');
  
  const opportunities = [];
  
  // Find prescriptions where we might have a better NDC
  // Uses raw_data->net_profit for margin info
  const result = await pool.query(`
    SELECT DISTINCT ON (p.patient_id, pr.drug_name)
      p.patient_id,
      pr.drug_name,
      pr.ndc as current_ndc,
      COALESCE((pr.raw_data->>'net_profit')::numeric, 0) as net_profit,
      pr.raw_data->>'therapeutic_class' as therapeutic_class
    FROM prescriptions pr
    JOIN patients p ON p.patient_id = pr.patient_id
    WHERE pr.pharmacy_id = $1
      AND pr.dispensed_date > NOW() - INTERVAL '90 days'
      AND COALESCE((pr.raw_data->>'net_profit')::numeric, 0) < 5
    ORDER BY p.patient_id, pr.drug_name, pr.dispensed_date DESC
    LIMIT 100
  `, [pharmacyId]);
  
  for (const row of result.rows) {
    // Check if opportunity already exists
    const existing = await pool.query(`
      SELECT opportunity_id FROM opportunities 
      WHERE pharmacy_id = $1 AND patient_id = $2 
        AND opportunity_type = 'ndc_optimization'
        AND current_drug_name = $3
        AND status IN ('new', 'reviewed')
    `, [pharmacyId, row.patient_id, row.drug_name]);
    
    if (existing.rows.length === 0) {
      opportunities.push({
        pharmacy_id: pharmacyId,
        patient_id: row.patient_id,
        opportunity_type: 'ndc_optimization',
        current_ndc: row.current_ndc,
        current_drug_name: row.drug_name,
        recommended_drug_name: `${row.drug_name} (Preferred NDC)`,
        potential_margin_gain: Math.abs(row.net_profit) + 3, // Estimated gain
        clinical_rationale: 'Lower-cost NDC available with same therapeutic equivalence.',
        clinical_priority: 'medium',
      });
    }
  }
  
  return opportunities;
}

/**
 * Brand to Generic Engine
 * Finds brand drugs that have generic alternatives
 */
async function scanBrandToGeneric(pharmacyId) {
  console.log('   🔍 Scanning for brand to generic opportunities...');
  
  const opportunities = [];
  
  // Find brand-name drugs (simplified detection based on naming patterns and high AWP)
  const result = await pool.query(`
    SELECT DISTINCT ON (p.patient_id, pr.drug_name)
      p.patient_id,
      pr.drug_name,
      pr.ndc,
      COALESCE((pr.raw_data->>'awp')::numeric, 0) as awp,
      COALESCE((pr.raw_data->>'net_profit')::numeric, 0) as net_profit,
      pr.raw_data->>'therapeutic_class' as therapeutic_class
    FROM prescriptions pr
    JOIN patients p ON p.patient_id = pr.patient_id
    WHERE pr.pharmacy_id = $1
      AND pr.dispensed_date > NOW() - INTERVAL '90 days'
      AND pr.daw_code IN ('0', '1', '2')
      AND COALESCE((pr.raw_data->>'awp')::numeric, 0) > 100
    ORDER BY p.patient_id, pr.drug_name, pr.dispensed_date DESC
    LIMIT 50
  `, [pharmacyId]);
  
  for (const row of result.rows) {
    const existing = await pool.query(`
      SELECT opportunity_id FROM opportunities 
      WHERE pharmacy_id = $1 AND patient_id = $2 
        AND opportunity_type = 'brand_to_generic'
        AND current_drug_name = $3
        AND status IN ('new', 'reviewed')
    `, [pharmacyId, row.patient_id, row.drug_name]);
    
    if (existing.rows.length === 0) {
      const potentialSavings = (row.awp || 100) * 0.7; // Estimate 70% savings on generic
      
      opportunities.push({
        pharmacy_id: pharmacyId,
        patient_id: row.patient_id,
        opportunity_type: 'brand_to_generic',
        current_ndc: row.ndc,
        current_drug_name: row.drug_name,
        recommended_drug_name: `Generic ${row.drug_name}`,
        potential_margin_gain: potentialSavings,
        clinical_rationale: 'Generic equivalent available at significantly lower cost. FDA-rated therapeutically equivalent.',
        clinical_priority: 'high',
      });
    }
  }
  
  return opportunities;
}

/**
 * Therapeutic Interchange Engine
 * Finds opportunities to switch to preferred formulary drugs
 */
async function scanTherapeuticInterchange(pharmacyId) {
  console.log('   🔍 Scanning for therapeutic interchange opportunities...');
  
  const opportunities = [];
  
  // Find high-cost drugs in therapeutic classes with cheaper alternatives
  const result = await pool.query(`
    SELECT DISTINCT ON (p.patient_id, pr.raw_data->>'therapeutic_class')
      p.patient_id,
      pr.drug_name,
      pr.ndc,
      pr.raw_data->>'therapeutic_class' as therapeutic_class,
      COALESCE((pr.raw_data->>'net_profit')::numeric, 0) as net_profit,
      pr.insurance_bin
    FROM prescriptions pr
    JOIN patients p ON p.patient_id = pr.patient_id
    WHERE pr.pharmacy_id = $1
      AND pr.dispensed_date > NOW() - INTERVAL '90 days'
      AND COALESCE((pr.raw_data->>'net_profit')::numeric, 0) < 2
      AND pr.raw_data->>'therapeutic_class' IS NOT NULL
    ORDER BY p.patient_id, pr.raw_data->>'therapeutic_class', pr.dispensed_date DESC
    LIMIT 30
  `, [pharmacyId]);
  
  // Common therapeutic interchanges
  const interchanges = {
    'STATIN': { preferred: 'Atorvastatin 20mg', savings: 25 },
    'ACE INHIBITOR': { preferred: 'Lisinopril 10mg', savings: 15 },
    'ARB': { preferred: 'Losartan 50mg', savings: 20 },
    'PPI': { preferred: 'Omeprazole 20mg', savings: 18 },
    'SSRI': { preferred: 'Sertraline 50mg', savings: 12 },
  };
  
  for (const row of result.rows) {
    const tcUpper = (row.therapeutic_class || '').toUpperCase();
    let interchange = null;
    
    for (const [key, value] of Object.entries(interchanges)) {
      if (tcUpper.includes(key)) {
        interchange = value;
        break;
      }
    }
    
    if (interchange) {
      const existing = await pool.query(`
        SELECT opportunity_id FROM opportunities 
        WHERE pharmacy_id = $1 AND patient_id = $2 
          AND opportunity_type = 'therapeutic_interchange'
          AND current_drug_name = $3
          AND status IN ('new', 'reviewed')
      `, [pharmacyId, row.patient_id, row.drug_name]);
      
      if (existing.rows.length === 0) {
        opportunities.push({
          pharmacy_id: pharmacyId,
          patient_id: row.patient_id,
          opportunity_type: 'therapeutic_interchange',
          current_ndc: row.ndc,
          current_drug_name: row.drug_name,
          recommended_drug_name: interchange.preferred,
          potential_margin_gain: interchange.savings,
          clinical_rationale: `Therapeutically equivalent ${interchange.preferred} available with better margin. Same clinical outcomes expected.`,
          clinical_priority: 'medium',
        });
      }
    }
  }
  
  return opportunities;
}

/**
 * Missing Therapy Engine
 * Finds patients who might benefit from additional medications based on conditions
 */
async function scanMissingTherapy(pharmacyId) {
  console.log('   🔍 Scanning for missing therapy opportunities...');
  
  const opportunities = [];
  
  // Find diabetic patients not on statins (guideline recommendation)
  const diabeticResult = await pool.query(`
    SELECT DISTINCT p.patient_id, p.chronic_conditions
    FROM patients p
    WHERE p.pharmacy_id = $1
      AND (
        p.chronic_conditions::text LIKE '%Diabetes%'
        OR p.chronic_conditions::text LIKE '%diabetes%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM prescriptions pr 
        WHERE pr.patient_id = p.patient_id 
          AND pr.dispensed_date > NOW() - INTERVAL '180 days'
          AND UPPER(COALESCE(pr.raw_data->>'therapeutic_class', '')) LIKE '%STATIN%'
      )
    LIMIT 20
  `, [pharmacyId]);
  
  for (const row of diabeticResult.rows) {
    const existing = await pool.query(`
      SELECT opportunity_id FROM opportunities 
      WHERE pharmacy_id = $1 AND patient_id = $2 
        AND opportunity_type = 'missing_therapy'
        AND recommended_drug_name LIKE '%statin%'
        AND status IN ('new', 'reviewed')
    `, [pharmacyId, row.patient_id]);
    
    if (existing.rows.length === 0) {
      opportunities.push({
        pharmacy_id: pharmacyId,
        patient_id: row.patient_id,
        opportunity_type: 'missing_therapy',
        current_ndc: null,
        current_drug_name: null,
        recommended_drug_name: 'Atorvastatin 20mg',
        potential_margin_gain: 15,
        clinical_rationale: 'ADA guidelines recommend statin therapy for diabetic patients for cardiovascular risk reduction.',
        clinical_priority: 'high',
      });
    }
  }
  
  // Find hypertensive patients not on ACE/ARB
  const htnResult = await pool.query(`
    SELECT DISTINCT p.patient_id, p.chronic_conditions
    FROM patients p
    WHERE p.pharmacy_id = $1
      AND (
        p.chronic_conditions::text LIKE '%Hypertension%'
        OR p.chronic_conditions::text LIKE '%hypertension%'
      )
      AND NOT EXISTS (
        SELECT 1 FROM prescriptions pr 
        WHERE pr.patient_id = p.patient_id 
          AND pr.dispensed_date > NOW() - INTERVAL '180 days'
          AND (
            UPPER(COALESCE(pr.raw_data->>'therapeutic_class', '')) LIKE '%ACE%' 
            OR UPPER(COALESCE(pr.raw_data->>'therapeutic_class', '')) LIKE '%ARB%'
          )
      )
    LIMIT 20
  `, [pharmacyId]);
  
  for (const row of htnResult.rows) {
    const existing = await pool.query(`
      SELECT opportunity_id FROM opportunities 
      WHERE pharmacy_id = $1 AND patient_id = $2 
        AND opportunity_type = 'missing_therapy'
        AND recommended_drug_name LIKE '%Lisinopril%'
        AND status IN ('new', 'reviewed')
    `, [pharmacyId, row.patient_id]);
    
    if (existing.rows.length === 0) {
      opportunities.push({
        pharmacy_id: pharmacyId,
        patient_id: row.patient_id,
        opportunity_type: 'missing_therapy',
        current_ndc: null,
        current_drug_name: null,
        recommended_drug_name: 'Lisinopril 10mg',
        potential_margin_gain: 12,
        clinical_rationale: 'JNC guidelines recommend ACE inhibitor or ARB for hypertensive patients, especially with diabetes or CKD.',
        clinical_priority: 'medium',
      });
    }
  }
  
  return opportunities;
}

/**
 * Admin Triggers Engine
 * Uses triggers configured in the admin panel
 */
async function scanAdminTriggers(pharmacyId) {
  console.log('   🔍 Scanning admin-configured triggers...');

  const opportunities = [];

  // Get all enabled triggers with their BIN values
  const triggersResult = await pool.query(`
    SELECT t.*,
      COALESCE(
        (SELECT json_agg(json_build_object(
          'insurance_bin', tbv.insurance_bin,
          'insurance_group', tbv.insurance_group,
          'gp_value', tbv.gp_value,
          'coverage_status', tbv.coverage_status
        ))
        FROM trigger_bin_values tbv
        WHERE tbv.trigger_id = t.trigger_id
        ), '[]'
      ) as bin_values
    FROM triggers t
    WHERE t.is_enabled = true
    ORDER BY t.priority ASC
  `);

  const triggers = triggersResult.rows;
  console.log(`      Found ${triggers.length} enabled triggers`);

  // Get all recent prescriptions with patient info
  const prescriptionsResult = await pool.query(`
    SELECT
      pr.prescription_id,
      pr.patient_id,
      pr.drug_name,
      pr.ndc,
      pr.insurance_bin,
      pr.insurance_group,
      pr.prescriber_name,
      COALESCE((pr.raw_data->>'gross_profit')::numeric, (pr.raw_data->>'net_profit')::numeric, 0) as profit,
      p.chronic_conditions
    FROM prescriptions pr
    JOIN patients p ON p.patient_id = pr.patient_id
    WHERE pr.pharmacy_id = $1
      AND pr.dispensed_date > NOW() - INTERVAL '90 days'
    ORDER BY pr.dispensed_date DESC
  `, [pharmacyId]);

  const prescriptions = prescriptionsResult.rows;
  console.log(`      Checking ${prescriptions.length} prescriptions against triggers`);

  // Build a map of patient's other drugs for if_has/if_not_has checks
  const patientDrugsMap = new Map();
  for (const rx of prescriptions) {
    if (!patientDrugsMap.has(rx.patient_id)) {
      patientDrugsMap.set(rx.patient_id, []);
    }
    patientDrugsMap.get(rx.patient_id).push(rx.drug_name?.toUpperCase() || '');
  }

  // Track which patient+trigger combos we've already created
  const createdOpps = new Set();

  for (const trigger of triggers) {
    const detectionKeywords = trigger.detection_keywords || [];
    const excludeKeywords = trigger.exclude_keywords || [];
    const ifHasKeywords = trigger.if_has_keywords || [];
    const ifNotHasKeywords = trigger.if_not_has_keywords || [];
    const binValues = typeof trigger.bin_values === 'string'
      ? JSON.parse(trigger.bin_values)
      : trigger.bin_values || [];

    if (detectionKeywords.length === 0) continue;

    for (const rx of prescriptions) {
      const drugName = (rx.drug_name || '').toUpperCase();

      // Check if ALL detection keywords match
      const matchesDetection = detectionKeywords.every(kw =>
        drugName.includes(kw.toUpperCase())
      );
      if (!matchesDetection) continue;

      // Check exclusions - skip if ANY exclude keyword matches
      const matchesExclusion = excludeKeywords.some(kw =>
        drugName.includes(kw.toUpperCase())
      );
      if (matchesExclusion) continue;

      // Check if_has_keywords - patient must have at least one of these drugs
      if (ifHasKeywords.length > 0) {
        const patientDrugs = patientDrugsMap.get(rx.patient_id) || [];
        const hasRequired = ifHasKeywords.some(kw =>
          patientDrugs.some(d => d.includes(kw.toUpperCase()))
        );
        if (!hasRequired) continue;
      }

      // Check if_not_has_keywords - patient must NOT have any of these drugs
      if (ifNotHasKeywords.length > 0) {
        const patientDrugs = patientDrugsMap.get(rx.patient_id) || [];
        const hasExcluded = ifNotHasKeywords.some(kw =>
          patientDrugs.some(d => d.includes(kw.toUpperCase()))
        );
        if (hasExcluded) continue;
      }

      // Determine GP value based on BIN/Group
      let gpValue = trigger.default_gp_value || 50;
      let skipDueToBin = false;

      if (binValues.length > 0) {
        // Try exact BIN + Group match first
        let binMatch = binValues.find(bv =>
          bv.insurance_bin === rx.insurance_bin &&
          bv.insurance_group === rx.insurance_group
        );

        // Fall back to BIN-only match
        if (!binMatch) {
          binMatch = binValues.find(bv =>
            bv.insurance_bin === rx.insurance_bin &&
            !bv.insurance_group
          );
        }

        if (binMatch) {
          if (binMatch.coverage_status === 'excluded') {
            skipDueToBin = true;
          } else {
            gpValue = binMatch.gp_value || gpValue;
          }
        }
        // If BIN not in list, use default GP (don't skip)
      }

      if (skipDueToBin) continue;

      // Deduplicate: one opp per patient per trigger
      const oppKey = `${rx.patient_id}:${trigger.trigger_id}`;
      if (createdOpps.has(oppKey)) continue;

      // Check if opportunity already exists in DB (same patient + same recommended drug)
      const existing = await pool.query(`
        SELECT opportunity_id FROM opportunities
        WHERE pharmacy_id = $1 AND patient_id = $2
          AND recommended_drug_name = $3
          AND status IN ('Not Submitted', 'Submitted', 'Pending')
      `, [pharmacyId, rx.patient_id, trigger.recommended_drug || trigger.display_name]);

      if (existing.rows.length > 0) {
        createdOpps.add(oppKey);
        continue;
      }

      createdOpps.add(oppKey);

      opportunities.push({
        pharmacy_id: pharmacyId,
        patient_id: rx.patient_id,
        prescription_id: rx.prescription_id,
        opportunity_type: trigger.trigger_type || 'therapeutic_interchange',
        current_ndc: rx.ndc,
        current_drug_name: rx.drug_name,
        recommended_drug_name: trigger.recommended_drug || trigger.display_name,
        potential_margin_gain: gpValue,
        clinical_rationale: trigger.clinical_rationale || trigger.action_instructions || `${trigger.display_name} opportunity identified.`,
        clinical_priority: trigger.priority <= 2 ? 'high' : trigger.priority <= 4 ? 'medium' : 'low',
        prescriber_name: rx.prescriber_name,
      });
    }
  }

  console.log(`      Generated ${opportunities.length} trigger-based opportunities`);
  return opportunities;
}

// ============================================
// MAIN SCANNER FUNCTION
// ============================================
async function runScanner(clientEmail) {
  console.log(`\n🚀 Running opportunity scanner for ${clientEmail}...\n`);
  
  // Get pharmacy info
  const clientResult = await pool.query(`
    SELECT c.client_id, p.pharmacy_id, c.client_name
    FROM clients c
    JOIN pharmacies p ON p.client_id = c.client_id
    WHERE c.submitter_email = $1
  `, [clientEmail.toLowerCase()]);
  
  if (clientResult.rows.length === 0) {
    throw new Error(`Client not found: ${clientEmail}`);
  }
  
  const { pharmacy_id, client_name } = clientResult.rows[0];
  console.log(`📦 Scanning for: ${client_name}\n`);
  
  // Run all scanners
  const allOpportunities = [];
  
  const ndcOpps = await scanNDCOptimizations(pharmacy_id);
  allOpportunities.push(...ndcOpps);
  console.log(`      Found ${ndcOpps.length} NDC optimization opportunities`);
  
  const brandOpps = await scanBrandToGeneric(pharmacy_id);
  allOpportunities.push(...brandOpps);
  console.log(`      Found ${brandOpps.length} brand-to-generic opportunities`);
  
  const interchangeOpps = await scanTherapeuticInterchange(pharmacy_id);
  allOpportunities.push(...interchangeOpps);
  console.log(`      Found ${interchangeOpps.length} therapeutic interchange opportunities`);
  
  const missingOpps = await scanMissingTherapy(pharmacy_id);
  allOpportunities.push(...missingOpps);
  console.log(`      Found ${missingOpps.length} missing therapy opportunities`);

  const triggerOpps = await scanAdminTriggers(pharmacy_id);
  allOpportunities.push(...triggerOpps);
  console.log(`      Found ${triggerOpps.length} admin trigger opportunities`);

  // Insert opportunities
  console.log(`\n💾 Saving ${allOpportunities.length} opportunities to database...`);
  
  let inserted = 0;
  for (const opp of allOpportunities) {
    try {
      await pool.query(`
        INSERT INTO opportunities (
          opportunity_id, pharmacy_id, patient_id, prescription_id, opportunity_type,
          current_ndc, current_drug_name, recommended_ndc, recommended_drug_name,
          potential_margin_gain, annual_margin_gain,
          clinical_rationale, clinical_priority, prescriber_name, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [
        uuidv4(),
        opp.pharmacy_id,
        opp.patient_id,
        opp.prescription_id || null,
        opp.opportunity_type,
        opp.current_ndc,
        opp.current_drug_name,
        null,
        opp.recommended_drug_name,
        opp.potential_margin_gain,
        opp.potential_margin_gain * 12,
        opp.clinical_rationale,
        opp.clinical_priority,
        opp.prescriber_name || null,
        'Not Submitted'
      ]);
      inserted++;
    } catch (error) {
      // Log first few errors to see what's happening
      if (inserted === 0) {
        console.error(`   Insert error: ${error.message}`);
      }
    }
  }
  
  // Calculate totals
  const totals = await pool.query(`
    SELECT 
      COUNT(*) as total_opportunities,
      SUM(potential_margin_gain) as total_margin
    FROM opportunities 
    WHERE pharmacy_id = $1 AND status = 'new'
  `, [pharmacy_id]);
  
  console.log(`\n✅ Scanner complete!`);
  console.log(`   📊 New opportunities created: ${inserted}`);
  console.log(`   💰 Total pending opportunities: ${totals.rows[0].total_opportunities}`);
  console.log(`   💵 Total potential margin: $${parseFloat(totals.rows[0].total_margin || 0).toFixed(2)}`);
  
  // Log scan (skip if table schema doesn't match)
  try {
    await pool.query(`
      INSERT INTO scan_logs (
        pharmacy_id, scan_type, opportunities_found,
        execution_time_ms, status
      ) VALUES ($1, $2, $3, $4, $5)
    `, [pharmacy_id, 'full_scan', inserted, 0, 'completed']);
  } catch (logError) {
    console.log('   (Skipped scan log - table schema mismatch)');
  }
  
  return { inserted, total: totals.rows[0] };
}

// ============================================
// CLI INTERFACE
// ============================================
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log('\nUsage: node run-scanner.js <client-email>\n');
  console.log('Example:');
  console.log('  node run-scanner.js contact@mybravorx.com');
  console.log('  node run-scanner.js michaelbakerrph@gmail.com\n');
  process.exit(1);
}

const [clientEmail] = args;

runScanner(clientEmail)
  .then(() => {
    console.log('\n🎉 Done! Client can now log in and see their opportunities.\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Scanner failed:', err.message);
    process.exit(1);
  });
