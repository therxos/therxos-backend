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
        AND status NOT IN ('Denied', 'Declined')
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
        AND status NOT IN ('Denied', 'Declined')
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
          AND status NOT IN ('Denied', 'Declined')
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
        AND status NOT IN ('Denied', 'Declined')
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
        AND status NOT IN ('Denied', 'Declined')
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
 * Build flexible drug name patterns for matching
 * Handles variations like "Fluticasone-Salmeterol" vs "FLUTICASONE PROPIONATE-SALMETEROL"
 */
function buildDrugPatterns(drugName) {
  if (!drugName) return [];

  const patterns = [];
  const upperDrug = drugName.toUpperCase().trim();

  // For combo drugs (hyphenated), match on component prefixes
  if (upperDrug.includes('-')) {
    const components = upperDrug.split('-').map(c => c.trim());

    // Add patterns for each component (min 5 chars for safety)
    for (const comp of components) {
      if (comp.length >= 5) {
        patterns.push(`%${comp.substring(0, 5)}%`);
      } else if (comp.length >= 4) {
        patterns.push(`%${comp}%`);
      }
    }

    // Add pattern for first component + hyphen (catches most combos)
    if (components[0].length >= 4) {
      patterns.push(`%${components[0].substring(0, 5)}%-${components[1] ? components[1].substring(0, 4) : ''}%`);
    }
  } else {
    // Single drug - use first 5+ chars
    const baseWord = upperDrug.split(/\s+/)[0];
    if (baseWord.length >= 5) {
      patterns.push(`%${baseWord.substring(0, 6)}%`);
    } else {
      patterns.push(`%${baseWord}%`);
    }
  }

  // Always add full first word as pattern
  const firstWord = upperDrug.split(/\s+/)[0];
  if (firstWord.length >= 4) {
    patterns.push(`%${firstWord}%`);
  }

  return [...new Set(patterns)]; // Dedupe
}

/**
 * Look up GP from existing paid claims of a drug with matching insurance
 * Matches by: drug name + (BIN/GROUP or CONTRACT_ID/PLAN_NAME or all 4)
 * Uses flexible matching to handle drug name variations across wholesalers
 */
async function lookupRecommendedDrugGP(pharmacyId, recommendedDrug, insuranceInfo) {
  if (!recommendedDrug) return null;

  const { insurance_bin, insurance_group, contract_id, plan_name } = insuranceInfo;

  // Build flexible patterns for drug name matching
  const patterns = buildDrugPatterns(recommendedDrug);
  if (patterns.length === 0) return null;

  // Build OR clause for all patterns - starting at $6 (after pharmacyId and 4 insurance fields)
  const patternConditions = patterns.map((_, i) => `UPPER(drug_name) LIKE $${i + 6}`).join(' OR ');

  // Search for existing paid claims of this drug with matching insurance
  // Priority: exact match on all 4 fields > CONTRACT+PLAN > BIN+GROUP > drug name only
  const query = `
    SELECT
      drug_name,
      insurance_bin,
      insurance_group,
      contract_id,
      plan_name,
      COALESCE(
        (raw_data->>'gross_profit')::numeric,
        (raw_data->>'net_profit')::numeric,
        insurance_pay - COALESCE(acquisition_cost, 0),
        0
      ) as gp,
      days_supply,
      -- Score matches: all 4 = 4, contract+plan = 3, bin+group = 2, drug only = 1
      CASE
        WHEN insurance_bin = $2 AND insurance_group = $3 AND contract_id = $4 AND plan_name = $5 THEN 4
        WHEN contract_id = $4 AND plan_name = $5 AND contract_id IS NOT NULL THEN 3
        WHEN insurance_bin = $2 AND insurance_group = $3 AND insurance_bin IS NOT NULL THEN 2
        ELSE 1
      END as match_score
    FROM prescriptions
    WHERE pharmacy_id = $1
      AND (${patternConditions})
      AND dispensed_date > NOW() - INTERVAL '365 days'
      AND (
        (insurance_bin = $2 AND insurance_group = $3)
        OR (contract_id = $4 AND plan_name = $5)
        OR (insurance_bin = $2)
        OR (contract_id = $4)
        OR TRUE  -- Allow drug-only match as fallback
      )
    ORDER BY match_score DESC, dispensed_date DESC
    LIMIT 10
  `;

  const params = [pharmacyId, insurance_bin, insurance_group, contract_id, plan_name, ...patterns];

  const result = await pool.query(query, params);

  if (result.rows.length === 0) return null;

  // Calculate average GP from best matches, normalized to 30-day supply
  const bestScore = result.rows[0].match_score;
  const bestMatches = result.rows.filter(r => r.match_score === bestScore);

  let totalGP = 0;
  for (const match of bestMatches) {
    const daysSupply = parseInt(match.days_supply) || 30;
    const normalizedGP = daysSupply >= 84 ? parseFloat(match.gp) / 3 : parseFloat(match.gp);
    totalGP += normalizedGP;
  }

  const avgGP = totalGP / bestMatches.length;

  return {
    gp: Math.round(avgGP * 100) / 100,
    matchScore: bestScore,
    matchCount: bestMatches.length,
    matchType: bestScore === 4 ? 'all_4_fields' :
               bestScore === 3 ? 'contract_plan' :
               bestScore === 2 ? 'bin_group' : 'drug_only',
    sampleDrug: bestMatches[0].drug_name,
    patterns: patterns
  };
}

/**
 * Build a cache of GP values for all recommended drugs
 * Key format: "DRUGPATTERN|BIN|GROUP|CONTRACT|PLAN" -> { gp, matchScore, matchType }
 */
async function buildRecommendedDrugGPCache(pharmacyId, triggers) {
  const cache = new Map();

  // Get unique recommended drugs from triggers
  const recommendedDrugs = [...new Set(
    triggers
      .map(t => t.recommended_drug)
      .filter(Boolean)
  )];

  if (recommendedDrugs.length === 0) return cache;

  // Build all drug patterns
  const allPatterns = [];
  const drugToPatterns = new Map();

  for (const drug of recommendedDrugs) {
    const patterns = buildDrugPatterns(drug);
    drugToPatterns.set(drug, patterns);
    allPatterns.push(...patterns);
  }

  const uniquePatterns = [...new Set(allPatterns)];
  if (uniquePatterns.length === 0) return cache;

  // Build one big query to get all GP data
  const patternConditions = uniquePatterns.map((_, i) => `UPPER(drug_name) LIKE $${i + 2}`).join(' OR ');

  const query = `
    SELECT
      drug_name,
      insurance_bin,
      insurance_group,
      contract_id,
      plan_name,
      COALESCE(
        (raw_data->>'gross_profit')::numeric,
        (raw_data->>'net_profit')::numeric,
        insurance_pay - COALESCE(acquisition_cost, 0),
        0
      ) as gp,
      days_supply
    FROM prescriptions
    WHERE pharmacy_id = $1
      AND (${patternConditions})
      AND dispensed_date > NOW() - INTERVAL '365 days'
    ORDER BY dispensed_date DESC
  `;

  const params = [pharmacyId, ...uniquePatterns];
  const result = await pool.query(query, params);

  // Group results by drug pattern and insurance
  for (const row of result.rows) {
    const drugUpper = (row.drug_name || '').toUpperCase();
    const daysSupply = parseInt(row.days_supply) || 30;
    const normalizedGP = daysSupply >= 84 ? parseFloat(row.gp) / 3 : parseFloat(row.gp);

    // Calculate match score
    let matchScore = 1; // drug only
    if (row.insurance_bin && row.insurance_group && row.contract_id && row.plan_name) {
      matchScore = 4;
    } else if (row.contract_id && row.plan_name) {
      matchScore = 3;
    } else if (row.insurance_bin && row.insurance_group) {
      matchScore = 2;
    }

    // Create cache keys for each insurance combination level
    const keys = [
      // All 4 fields
      `${drugUpper}|${row.insurance_bin}|${row.insurance_group}|${row.contract_id}|${row.plan_name}`,
      // CONTRACT + PLAN
      `${drugUpper}|||${row.contract_id}|${row.plan_name}`,
      // BIN + GROUP
      `${drugUpper}|${row.insurance_bin}|${row.insurance_group}||`,
      // Drug only
      `${drugUpper}||||`
    ];

    for (const key of keys) {
      if (!cache.has(key)) {
        cache.set(key, { gps: [], matchScore });
      }
      cache.get(key).gps.push(normalizedGP);
    }
  }

  // Calculate averages
  for (const [key, data] of cache) {
    const avgGP = data.gps.reduce((a, b) => a + b, 0) / data.gps.length;
    cache.set(key, {
      gp: Math.round(avgGP * 100) / 100,
      matchScore: data.matchScore,
      matchCount: data.gps.length
    });
  }

  return cache;
}

/**
 * Look up GP from cache
 */
function lookupGPFromCache(cache, recommendedDrug, insuranceInfo) {
  if (!recommendedDrug || !cache) return null;

  const { insurance_bin, insurance_group, contract_id, plan_name } = insuranceInfo;
  const patterns = buildDrugPatterns(recommendedDrug);

  // Try each pattern with each insurance level (most specific first)
  for (const pattern of patterns) {
    const drugBase = pattern.replace(/%/g, '').toUpperCase();

    // Try to find matching keys in cache
    for (const [key, data] of cache) {
      const [cachedDrug, bin, group, contractId, planName] = key.split('|');

      // Check if drug matches
      if (!cachedDrug.includes(drugBase) && !drugBase.includes(cachedDrug.substring(0, 5))) {
        continue;
      }

      // Check insurance match level
      if (bin === insurance_bin && group === insurance_group &&
          contractId === contract_id && planName === plan_name) {
        return { ...data, matchType: 'all_4_fields' };
      }
      if (contractId === contract_id && planName === plan_name && contractId) {
        return { ...data, matchType: 'contract_plan' };
      }
      if (bin === insurance_bin && group === insurance_group && bin) {
        return { ...data, matchType: 'bin_group' };
      }
    }
  }

  // Fall back to drug-only match
  for (const pattern of patterns) {
    const drugBase = pattern.replace(/%/g, '').toUpperCase();
    for (const [key, data] of cache) {
      const [cachedDrug] = key.split('|');
      if (cachedDrug.includes(drugBase) || drugBase.includes(cachedDrug.substring(0, 5))) {
        return { ...data, matchType: 'drug_only' };
      }
    }
  }

  return null;
}

/**
 * Admin Triggers Engine
 * Uses triggers configured in the admin panel
 */
async function scanAdminTriggers(pharmacyId) {
  console.log('   🔍 Scanning admin-configured triggers...');

  const opportunities = [];

  // Get all enabled triggers with their BIN values and restrictions
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
      pr.contract_id,
      pr.plan_name,
      pr.prescriber_name,
      pr.days_supply,
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

  // Pre-cache GP data for all recommended drugs (much faster than per-opportunity lookup)
  console.log(`      Pre-loading GP data for recommended drugs...`);
  const recommendedDrugGPCache = await buildRecommendedDrugGPCache(pharmacyId, triggers);
  console.log(`      Cached GP data for ${recommendedDrugGPCache.size} drug+insurance combinations`);

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

      // Check if ANY detection keywords match
      const matchesDetection = detectionKeywords.some(kw =>
        drugName.includes(kw.toUpperCase())
      );
      if (!matchesDetection) continue;

      // Check exclusions - skip if ANY exclude keyword matches
      const matchesExclusion = excludeKeywords.some(kw =>
        drugName.includes(kw.toUpperCase())
      );
      if (matchesExclusion) continue;

      // Check bin_restrictions - if set, patient's BIN must be in the list
      const binRestrictions = trigger.bin_restrictions || [];
      if (binRestrictions.length > 0) {
        const patientBin = rx.insurance_bin || '';
        const binAllowed = binRestrictions.some(bin => bin === patientBin);
        if (!binAllowed) continue;
      }

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

      // Determine GP value - priority order:
      // 1. Pre-configured bin_values from trigger
      // 2. Lookup actual paid claims for recommended drug with matching insurance
      // 3. Trigger's default_gp_value
      // 4. Current drug's profit
      // 5. Fall back to $50
      const daysSupply = parseInt(rx.days_supply) || 30;
      const rawProfit = Math.abs(parseFloat(rx.profit)) || 0;
      const rxProfit = daysSupply >= 84 ? rawProfit / 3 : rawProfit; // Normalize 90-day to 30-day

      let gpValue = null;
      let gpSource = 'fallback';
      let skipDueToBin = false;

      // 1. Check pre-configured bin_values first
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
          } else if (binMatch.gp_value) {
            gpValue = binMatch.gp_value;
            gpSource = 'bin_values';
          }
        }
      }

      if (skipDueToBin) continue;

      // 2. If no GP yet, lookup from pre-cached paid claims data
      if (!gpValue && trigger.recommended_drug) {
        const lookupResult = lookupGPFromCache(recommendedDrugGPCache, trigger.recommended_drug, {
          insurance_bin: rx.insurance_bin,
          insurance_group: rx.insurance_group,
          contract_id: rx.contract_id,
          plan_name: rx.plan_name
        });

        if (lookupResult && lookupResult.gp > 0) {
          gpValue = lookupResult.gp;
          gpSource = `paid_claims_${lookupResult.matchType}`;
        }
      }

      // 3. Try trigger's default_gp_value
      if (!gpValue && trigger.default_gp_value != null && trigger.default_gp_value > 0) {
        gpValue = trigger.default_gp_value;
        gpSource = 'trigger_default';
      }

      // 4. Fall back to current drug's profit
      if (!gpValue && rxProfit > 0) {
        gpValue = rxProfit;
        gpSource = 'current_rx_profit';
      }

      // 5. Final fallback
      if (!gpValue) {
        gpValue = 50;
        gpSource = 'fallback_50';
      }

      // Skip opportunities below $10 per 30-day fill threshold
      if (gpValue < 10) continue;

      // Deduplicate: one opp per patient per trigger
      const oppKey = `${rx.patient_id}:${trigger.trigger_id}`;
      if (createdOpps.has(oppKey)) continue;

      // Check if opportunity already exists in DB (same patient + same recommended drug)
      // Skip if ANY existing opp found (except Denied/Declined which can be retried)
      const existing = await pool.query(`
        SELECT opportunity_id FROM opportunities
        WHERE pharmacy_id = $1 AND patient_id = $2
          AND recommended_drug_name = $3
          AND status NOT IN ('Denied', 'Declined')
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
  
  // Run admin triggers scanner only (hardcoded engines disabled - use admin panel for full control)
  const allOpportunities = [];

  // Legacy hardcoded engines - DISABLED
  // These produced low-quality opportunities with poor margins
  // Use admin-configured triggers instead for full control over detection and pricing
  // const ndcOpps = await scanNDCOptimizations(pharmacy_id);
  // const brandOpps = await scanBrandToGeneric(pharmacy_id);
  // const interchangeOpps = await scanTherapeuticInterchange(pharmacy_id);
  // const missingOpps = await scanMissingTherapy(pharmacy_id);

  const triggerOpps = await scanAdminTriggers(pharmacy_id);
  allOpportunities.push(...triggerOpps);
  console.log(`   ✅ Found ${triggerOpps.length} opportunities from admin triggers`);

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
