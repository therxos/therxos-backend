// Opportunity Scanning Engine for TheRxOS V2
// Uses admin-configured triggers from the super admin panel
// Audits are handled separately by audit-scanner.js

import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

/**
 * Drug class mappings for condition inference (used by updatePatientProfiles)
 */
const DRUG_CLASS_CONDITIONS = {
  statins: ['CVD', 'Hyperlipidemia'],
  ace_inhibitors: ['HTN', 'CVD', 'Heart Failure'],
  arbs: ['HTN', 'CVD', 'Heart Failure'],
  beta_blockers: ['HTN', 'CVD', 'Heart Failure', 'Arrhythmia'],
  ccb: ['HTN', 'Angina'],
  thiazides: ['HTN'],
  loop_diuretics: ['Heart Failure', 'Edema'],
  metformin: ['Diabetes'],
  sulfonylureas: ['Diabetes'],
  sglt2: ['Diabetes', 'Heart Failure'],
  glp1: ['Diabetes', 'Obesity'],
  dpp4: ['Diabetes'],
  insulin: ['Diabetes'],
  laba: ['COPD', 'Asthma'],
  lama: ['COPD'],
  ics: ['Asthma', 'COPD'],
  ics_laba: ['Asthma', 'COPD'],
  saba: ['Asthma', 'COPD'],
  ssri: ['Depression', 'Anxiety'],
  snri: ['Depression', 'Anxiety', 'Chronic Pain'],
  benzo: ['Anxiety', 'Insomnia'],
  antipsychotics: ['Schizophrenia', 'Bipolar'],
  opioids: ['Chronic Pain', 'Acute Pain'],
  nsaids: ['Pain', 'Inflammation'],
  ppi: ['GERD', 'Ulcer'],
  h2_blockers: ['GERD', 'Ulcer'],
  thyroid: ['Hypothyroidism'],
  bisphosphonates: ['Osteoporosis'],
  anticoagulants: ['AFib', 'DVT', 'PE']
};

const DRUG_PATTERNS = {
  statins: /atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin|fluvastatin|pitavastatin|lipitor|crestor|zocor/i,
  ace_inhibitors: /lisinopril|enalapril|ramipril|benazepril|captopril|fosinopril|quinapril|moexipril|perindopril|trandolapril|prinivil|zestril|vasotec|altace/i,
  arbs: /losartan|valsartan|irbesartan|olmesartan|candesartan|telmisartan|azilsartan|cozaar|diovan|avapro/i,
  beta_blockers: /metoprolol|atenolol|carvedilol|bisoprolol|propranolol|nadolol|nebivolol|labetalol|lopressor|toprol|coreg/i,
  ccb: /amlodipine|nifedipine|diltiazem|verapamil|felodipine|nicardipine|norvasc|cardizem|procardia/i,
  thiazides: /hydrochlorothiazide|chlorthalidone|indapamide|metolazone|hctz/i,
  loop_diuretics: /furosemide|bumetanide|torsemide|lasix|bumex/i,
  metformin: /metformin|glucophage|fortamet|glumetza|riomet/i,
  sulfonylureas: /glipizide|glyburide|glimepiride|glucotrol|diabeta|micronase|amaryl/i,
  sglt2: /canagliflozin|dapagliflozin|empagliflozin|ertugliflozin|invokana|farxiga|jardiance|steglatro/i,
  glp1: /semaglutide|liraglutide|dulaglutide|exenatide|ozempic|wegovy|victoza|trulicity|byetta|bydureon/i,
  dpp4: /sitagliptin|saxagliptin|linagliptin|alogliptin|januvia|onglyza|tradjenta|nesina/i,
  insulin: /insulin|novolog|humalog|lantus|levemir|basaglar|tresiba|toujeo|admelog|fiasp/i,
  laba: /salmeterol|formoterol|vilanterol|olodaterol|indacaterol|serevent|foradil/i,
  lama: /tiotropium|umeclidinium|aclidinium|glycopyrrolate|spiriva|incruse|tudorza/i,
  ics: /fluticasone|budesonide|beclomethasone|mometasone|ciclesonide|flovent|pulmicort|qvar|asmanex|alvesco/i,
  ics_laba: /advair|symbicort|breo|dulera|wixela|airduo/i,
  saba: /albuterol|levalbuterol|proair|proventil|ventolin|xopenex/i,
  ssri: /fluoxetine|sertraline|paroxetine|escitalopram|citalopram|fluvoxamine|prozac|zoloft|paxil|lexapro|celexa/i,
  snri: /venlafaxine|duloxetine|desvenlafaxine|levomilnacipran|effexor|cymbalta|pristiq|fetzima/i,
  benzo: /alprazolam|lorazepam|clonazepam|diazepam|temazepam|xanax|ativan|klonopin|valium|restoril/i,
  opioids: /oxycodone|hydrocodone|morphine|fentanyl|tramadol|codeine|hydromorphone|oxycontin|percocet|vicodin|norco|dilaudid/i,
  nsaids: /ibuprofen|naproxen|meloxicam|diclofenac|celecoxib|indomethacin|ketorolac|motrin|advil|aleve|mobic|voltaren|celebrex/i,
  ppi: /omeprazole|esomeprazole|lansoprazole|pantoprazole|rabeprazole|dexlansoprazole|prilosec|nexium|prevacid|protonix|aciphex|dexilant/i,
  thyroid: /levothyroxine|synthroid|levoxyl|tirosint|unithroid|armour thyroid|liothyronine/i,
  bisphosphonates: /alendronate|risedronate|ibandronate|zoledronic|fosamax|actonel|boniva|reclast/i,
  anticoagulants: /warfarin|apixaban|rivaroxaban|dabigatran|edoxaban|coumadin|eliquis|xarelto|pradaxa|savaysa/i,
  glucose_test_strips: /freestyle|onetouch|one touch|contour|accu-chek|accu chek|true metrix|truemetrix|prodigy|relion|embrace|test strip|blood glucose strip/i,
  lancets: /lancet|microlet|unistik/i,
  pen_needles: /pen needle|novofine|novotwist|nano pen|bd nano/i
};

function detectDrugClass(drugName) {
  if (!drugName) return null;
  for (const [drugClass, pattern] of Object.entries(DRUG_PATTERNS)) {
    if (pattern.test(drugName)) return drugClass;
  }
  return null;
}

function inferConditionsFromDrugs(drugClasses) {
  const conditions = new Set();
  for (const drugClass of drugClasses) {
    const relatedConditions = DRUG_CLASS_CONDITIONS[drugClass] || [];
    relatedConditions.forEach(c => conditions.add(c));
  }
  return Array.from(conditions);
}

// ============================================
// TRIGGER-BASED SCANNING (Admin Panel Triggers)
// ============================================

/**
 * Build flexible drug name patterns for SQL LIKE matching
 */
function buildDrugPatterns(drugName) {
  if (!drugName) return [];

  const patterns = [];
  const upperDrug = drugName.toUpperCase().trim();

  if (upperDrug.includes('-')) {
    const components = upperDrug.split('-').map(c => c.trim());
    for (const comp of components) {
      if (comp.length >= 5) {
        patterns.push(`%${comp.substring(0, 5)}%`);
      } else if (comp.length >= 4) {
        patterns.push(`%${comp}%`);
      }
    }
    if (components[0].length >= 4) {
      patterns.push(`%${components[0].substring(0, 5)}%-${components[1] ? components[1].substring(0, 4) : ''}%`);
    }
  } else {
    const baseWord = upperDrug.split(/\s+/)[0];
    if (baseWord.length >= 5) {
      patterns.push(`%${baseWord.substring(0, 6)}%`);
    } else {
      patterns.push(`%${baseWord}%`);
    }
  }

  const firstWord = upperDrug.split(/\s+/)[0];
  if (firstWord.length >= 4) {
    patterns.push(`%${firstWord}%`);
  }

  return [...new Set(patterns)];
}

/**
 * Build a cache of GP values for all recommended drugs
 * Queries ALL pharmacies (data warehouse) not just current pharmacy
 */
async function buildRecommendedDrugGPCache(pharmacyId, triggers) {
  const cache = new Map();

  const recommendedDrugs = [...new Set(
    triggers.map(t => t.recommended_drug).filter(Boolean)
  )];

  if (recommendedDrugs.length === 0) return cache;

  const allPatterns = [];
  for (const drug of recommendedDrugs) {
    allPatterns.push(...buildDrugPatterns(drug));
  }

  const uniquePatterns = [...new Set(allPatterns)];
  if (uniquePatterns.length === 0) return cache;

  const patternConditions = uniquePatterns.map((_, i) => `UPPER(drug_name) LIKE $${i + 1}`).join(' OR ');

  const query = `
    SELECT
      drug_name, insurance_bin, insurance_group, contract_id, plan_name,
      COALESCE(
        NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'grossprofit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'GrossProfit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Net Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'netprofit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'NetProfit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'adj_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Adj Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'adjprofit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'AdjProfit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'adjusted_profit', ',', '')::numeric, 0),
        NULLIF(
          REPLACE(COALESCE(raw_data->>'Price','0'), '$', '')::numeric
          - REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', '')::numeric,
        0)
      ) as gp,
      days_supply
    FROM prescriptions
    WHERE (${patternConditions})
      AND dispensed_date > NOW() - INTERVAL '365 days'
    ORDER BY dispensed_date DESC
  `;

  const result = await db.query(query, [...uniquePatterns]);

  for (const row of result.rows) {
    const drugUpper = (row.drug_name || '').toUpperCase();
    const daysSupply = parseInt(row.days_supply) || 30;
    const normalizedGP = daysSupply >= 84 ? parseFloat(row.gp) / 3 : parseFloat(row.gp);

    let matchScore = 1;
    if (row.insurance_bin && row.insurance_group && row.contract_id && row.plan_name) {
      matchScore = 4;
    } else if (row.contract_id && row.plan_name) {
      matchScore = 3;
    } else if (row.insurance_bin && row.insurance_group) {
      matchScore = 2;
    }

    const keys = [
      `${drugUpper}|${row.insurance_bin}|${row.insurance_group}|${row.contract_id}|${row.plan_name}`,
      `${drugUpper}|||${row.contract_id}|${row.plan_name}`,
      `${drugUpper}|${row.insurance_bin}|${row.insurance_group}||`,
      `${drugUpper}||||`
    ];

    for (const key of keys) {
      if (!cache.has(key)) {
        cache.set(key, { gps: [], matchScore });
      }
      cache.get(key).gps.push(normalizedGP);
    }
  }

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

  for (const pattern of patterns) {
    const drugBase = pattern.replace(/%/g, '').toUpperCase();

    for (const [key, data] of cache) {
      const [cachedDrug, bin, group, contractId, planName] = key.split('|');

      if (!cachedDrug.includes(drugBase) && !drugBase.includes(cachedDrug.substring(0, 5))) {
        continue;
      }

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
 * Scan using admin-configured triggers
 */
async function scanAdminTriggers(pharmacyId, batchId) {
  const opportunities = [];

  // Get all enabled triggers with BIN values
  const triggersResult = await db.query(`
    SELECT t.*,
      COALESCE(
        (SELECT json_agg(json_build_object(
          'insurance_bin', tbv.insurance_bin,
          'insurance_group', tbv.insurance_group,
          'gp_value', tbv.gp_value,
          'coverage_status', tbv.coverage_status,
          'is_excluded', tbv.is_excluded,
          'best_ndc', tbv.best_ndc,
          'avg_qty', tbv.avg_qty
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
  logger.info(`Found ${triggers.length} enabled triggers`, { batchId });

  // Get recent prescriptions with patient info
  const prescriptionsResult = await db.query(`
    SELECT
      pr.prescription_id, pr.patient_id, pr.drug_name, pr.ndc,
      pr.insurance_bin, pr.insurance_group, pr.contract_id, pr.plan_name,
      pr.prescriber_name, pr.prescriber_npi, pr.days_supply,
      COALESCE(
        NULLIF(REPLACE(pr.raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'grossprofit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'GrossProfit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'net_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'Net Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'netprofit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'NetProfit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'adj_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'Adj Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'adjprofit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'AdjProfit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(pr.raw_data->>'adjusted_profit', ',', '')::numeric, 0),
        NULLIF(
          REPLACE(COALESCE(pr.raw_data->>'Price','0'), '$', '')::numeric
          - REPLACE(COALESCE(pr.raw_data->>'Actual Cost','0'), '$', '')::numeric,
        0)
      ) as profit,
      p.chronic_conditions
    FROM prescriptions pr
    JOIN patients p ON p.patient_id = pr.patient_id
    WHERE pr.pharmacy_id = $1
      AND pr.dispensed_date > NOW() - INTERVAL '90 days'
    ORDER BY pr.dispensed_date DESC
  `, [pharmacyId]);

  const prescriptions = prescriptionsResult.rows;
  logger.info(`Checking ${prescriptions.length} prescriptions against triggers`, { batchId });

  // Pre-cache GP data
  const recommendedDrugGPCache = await buildRecommendedDrugGPCache(pharmacyId, triggers);
  logger.info(`Cached GP data for ${recommendedDrugGPCache.size} drug+insurance combinations`, { batchId });

  // Build patient drug map for if_has/if_not_has checks
  const patientDrugsMap = new Map();
  for (const rx of prescriptions) {
    if (!patientDrugsMap.has(rx.patient_id)) {
      patientDrugsMap.set(rx.patient_id, []);
    }
    // Strip special characters so if_has/if_not_has matching isn't broken by *, #, etc.
    patientDrugsMap.get(rx.patient_id).push((rx.drug_name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' '));
  }

  const createdOpps = new Set();

  // Collect all candidate opportunities first, then pick best per patient+current_drug
  const candidateOpps = [];

  for (const trigger of triggers) {
    const detectionKeywords = trigger.detection_keywords || [];
    const excludeKeywords = trigger.exclude_keywords || [];
    const ifHasKeywords = trigger.if_has_keywords || [];
    const ifNotHasKeywords = trigger.if_not_has_keywords || [];
    const binValues = typeof trigger.bin_values === 'string'
      ? JSON.parse(trigger.bin_values)
      : trigger.bin_values || [];

    if (detectionKeywords.length === 0) continue;

    // Check pharmacy_inclusions - if set, skip if this pharmacy isn't in the list
    const pharmacyInclusions = trigger.pharmacy_inclusions || [];
    if (pharmacyInclusions.length > 0 && !pharmacyInclusions.includes(pharmacyId)) continue;

    // Normalize BIN/group inclusion/exclusion lists
    const binInclusions = (trigger.bin_inclusions || []).map(b => String(b).trim());
    const binExclusions = (trigger.bin_exclusions || []).map(b => String(b).trim());
    const groupInclusions = (trigger.group_inclusions || []).map(g => String(g).trim().toUpperCase());
    const groupExclusions = (trigger.group_exclusions || []).map(g => String(g).trim().toUpperCase());
    const keywordMatchMode = trigger.keyword_match_mode || 'any';

    for (const rx of prescriptions) {
      const drugNameRaw = (rx.drug_name || '').toUpperCase();
      // Strip special characters for matching (*, #, etc.) but keep letters, numbers, spaces
      const drugName = drugNameRaw.replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ');

      // Check detection keywords (any vs all mode)
      const matchesDetection = keywordMatchMode === 'all'
        ? detectionKeywords.every(kw => drugName.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
        : detectionKeywords.some(kw => drugName.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')));
      if (!matchesDetection) continue;

      // Check exclusions
      const matchesExclusion = excludeKeywords.some(kw =>
        drugName.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' '))
      );
      if (matchesExclusion) continue;

      // Check BIN inclusions - if set, patient's BIN must be in the list
      if (binInclusions.length > 0) {
        const patientBin = String(rx.insurance_bin || '').trim();
        if (!binInclusions.includes(patientBin)) continue;
      }

      // Check BIN exclusions - if set, skip if patient's BIN is in the list
      if (binExclusions.length > 0) {
        const patientBin = String(rx.insurance_bin || '').trim();
        if (binExclusions.includes(patientBin)) continue;
      }

      // Check group inclusions
      if (groupInclusions.length > 0) {
        const patientGroup = (rx.insurance_group || '').toUpperCase();
        if (patientGroup && !groupInclusions.includes(patientGroup)) continue;
      }

      // Check group exclusions
      if (groupExclusions.length > 0) {
        const patientGroup = (rx.insurance_group || '').toUpperCase();
        if (groupExclusions.includes(patientGroup)) continue;
      }

      // Check contract prefix exclusions
      const contractPrefixExclusions = trigger.contract_prefix_exclusions || [];
      if (contractPrefixExclusions.length > 0 && rx.contract_id) {
        const contractId = rx.contract_id.toUpperCase();
        if (contractPrefixExclusions.some(prefix =>
          contractId.startsWith(prefix.toUpperCase())
        )) continue;
      }

      // Check if_has_keywords
      if (ifHasKeywords.length > 0) {
        const patientDrugs = patientDrugsMap.get(rx.patient_id) || [];
        const hasRequired = ifHasKeywords.some(kw =>
          patientDrugs.some(d => d.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
        );
        if (!hasRequired) continue;
      }

      // Check if_not_has_keywords
      if (ifNotHasKeywords.length > 0) {
        const patientDrugs = patientDrugsMap.get(rx.patient_id) || [];
        const hasExcluded = ifNotHasKeywords.some(kw =>
          patientDrugs.some(d => d.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
        );
        if (hasExcluded) continue;
      }

      // Determine GP value
      const daysSupply = parseInt(rx.days_supply) || 30;
      const rawProfit = Math.abs(parseFloat(rx.profit)) || 0;
      const rxProfit = daysSupply >= 84 ? rawProfit / 3 : rawProfit;

      let gpValue = null;
      let skipDueToBin = false;
      let binMatch = null;

      // 1. Check pre-configured bin_values (from coverage scans)
      if (binValues.length > 0) {
        binMatch = binValues.find(bv =>
          bv.insurance_bin === rx.insurance_bin &&
          bv.insurance_group === rx.insurance_group
        );
        if (!binMatch) {
          binMatch = binValues.find(bv =>
            bv.insurance_bin === rx.insurance_bin &&
            !bv.insurance_group
          );
        }
        if (binMatch) {
          if (binMatch.is_excluded || binMatch.coverage_status === 'excluded') {
            skipDueToBin = true;
          } else if (binMatch.gp_value) {
            gpValue = binMatch.gp_value;
          }
        }
        // If BIN not in coverage data, fall through to default GP (don't skip)
      }

      if (skipDueToBin) continue;

      // 2. No coverage data at all - try cached paid claims
      if (!gpValue && trigger.recommended_drug) {
        const lookupResult = lookupGPFromCache(recommendedDrugGPCache, trigger.recommended_drug, {
          insurance_bin: rx.insurance_bin,
          insurance_group: rx.insurance_group,
          contract_id: rx.contract_id,
          plan_name: rx.plan_name
        });
        if (lookupResult && lookupResult.gp > 0) {
          gpValue = lookupResult.gp;
        }
      }

      // 3. Trigger default GP
      if (!gpValue && trigger.default_gp_value != null && trigger.default_gp_value > 0) {
        gpValue = trigger.default_gp_value;
      }

      // No GP value found - skip (never make up values)
      if (!gpValue || gpValue <= 0) continue;

      // Normalize GP to 30-day equivalent
      // When expected_days_supply is set on the trigger, coverage scanner already
      // normalized accurately using (30 / actual_days) — don't re-normalize
      if (trigger.expected_days_supply) {
        // Coverage scanner already handled normalization correctly
        // For non-coverage paths (default GP), assume it's already per-30-day
      } else if (binMatch?.avg_qty && binMatch.avg_qty > 34) {
        // Coverage scan may not have normalized — fix here
        const months = Math.ceil(binMatch.avg_qty / 30);
        gpValue = gpValue / months;
      } else if (!binMatch && daysSupply > 34) {
        // For non-coverage paths, use the prescription's days_supply
        gpValue = gpValue * (30 / daysSupply);
      }

      // Skip below $10 threshold
      if (gpValue < 10) continue;

      // Deduplicate: one opp per patient per trigger
      const oppKey = `${rx.patient_id}:${trigger.trigger_id}`;
      if (createdOpps.has(oppKey)) continue;
      createdOpps.add(oppKey);

      candidateOpps.push({
        opportunity_id: uuidv4(),
        pharmacy_id: pharmacyId,
        patient_id: rx.patient_id,
        prescription_id: rx.prescription_id,
        trigger_id: trigger.trigger_id,
        opportunity_type: trigger.trigger_type || 'therapeutic_interchange',
        current_ndc: rx.ndc,
        current_drug_name: rx.drug_name,
        recommended_drug_name: trigger.recommended_drug || trigger.display_name,
        recommended_ndc: binMatch?.best_ndc || trigger.recommended_ndc || null,
        avg_dispensed_qty: binMatch?.avg_qty || null,
        potential_margin_gain: gpValue,
        annual_margin_gain: gpValue * (parseInt(trigger.annual_fills) || 12),
        clinical_rationale: trigger.clinical_rationale || trigger.action_instructions || `${trigger.display_name} opportunity identified.`,
        clinical_priority: trigger.priority <= 2 ? 'high' : trigger.priority <= 4 ? 'medium' : 'low',
        prescriber_name: rx.prescriber_name,
        scan_batch_id: batchId,
        status: 'Not Submitted'
      });
    }
  }

  // Best-opp-only: for each patient + current drug BASE NAME, keep only the highest GP opportunity
  // This prevents e.g. 5 different amlodipine combo triggers all creating opps for the same patient
  // Uses first word of drug name as base (e.g. "Amlodipine 5 Mg Tab" → "AMLODIPINE")
  const bestOppsMap = new Map();
  for (const opp of candidateOpps) {
    const drugBase = (opp.current_drug_name || '').toUpperCase().split(/\s+/)[0];
    const key = `${opp.patient_id}:${drugBase}`;
    const existing = bestOppsMap.get(key);
    if (!existing || opp.potential_margin_gain > existing.potential_margin_gain) {
      bestOppsMap.set(key, opp);
    }
  }

  // Filter to best-only and check DB for existing opps
  // CRITICAL: A patient should NEVER have multiple ACTIVE opps for the same recommended drug
  // - If no existing opp: create new one
  // - If existing 'Not Submitted' opp: update it with better values (always keep best)
  // - If existing 'Denied'/'Declined' opp: create new (they said no before, but new option may work)
  // - If existing actioned opp (Submitted, Completed, Approved, etc.): skip (work already done)
  for (const opp of bestOppsMap.values()) {
    const existing = await db.query(`
      SELECT opportunity_id, status, annual_margin_gain
      FROM opportunities
      WHERE pharmacy_id = $1 AND patient_id = $2
        AND UPPER(COALESCE(recommended_drug_name, '')) = UPPER(COALESCE($3, ''))
      ORDER BY
        CASE
          WHEN status IN ('Submitted', 'Pending', 'Approved', 'Completed', 'Flagged', 'Didn''t Work') THEN 0
          WHEN status = 'Not Submitted' THEN 1
          ELSE 2  -- Denied, Declined
        END,
        created_at DESC
      LIMIT 1
    `, [pharmacyId, opp.patient_id, opp.recommended_drug_name]);

    if (existing.rows.length === 0) {
      // No existing opp - create new
      opportunities.push(opp);
    } else {
      const ex = existing.rows[0];

      if (ex.status === 'Not Submitted') {
        // Update existing Not Submitted with best values (higher margin or better NDC)
        if (opp.annual_margin_gain > (ex.annual_margin_gain || 0) || opp.recommended_ndc) {
          await db.query(`
            UPDATE opportunities SET
              recommended_ndc = COALESCE($1, recommended_ndc),
              avg_dispensed_qty = COALESCE($2, avg_dispensed_qty),
              potential_margin_gain = GREATEST($3, potential_margin_gain),
              annual_margin_gain = GREATEST($4, annual_margin_gain),
              trigger_id = COALESCE($5, trigger_id),
              prescription_id = COALESCE($6, prescription_id),
              current_ndc = COALESCE($7, current_ndc),
              current_drug_name = COALESCE($8, current_drug_name),
              updated_at = NOW()
            WHERE opportunity_id = $9
          `, [
            opp.recommended_ndc,
            opp.avg_dispensed_qty,
            opp.potential_margin_gain,
            opp.annual_margin_gain,
            opp.trigger_id,
            opp.prescription_id,
            opp.current_ndc,
            opp.current_drug_name,
            ex.opportunity_id
          ]);
          logger.debug(`Updated opp ${ex.opportunity_id} with better data: margin $${ex.annual_margin_gain} → $${opp.annual_margin_gain}`);
        }
      } else if (ex.status === 'Denied' || ex.status === 'Declined') {
        // Previous was denied - create new opp (maybe new option will work)
        opportunities.push(opp);
      }
      // If actioned (Submitted, Completed, etc.) - skip, work was already done
    }
  }

  logger.info(`Generated ${opportunities.length} opportunities (from ${candidateOpps.length} candidates, ${bestOppsMap.size} after best-only dedup)`, { batchId });
  return opportunities;
}

// ============================================
// MAIN SCAN FUNCTION
// ============================================

/**
 * Main opportunity scanning function - uses admin-configured triggers only
 */
export async function runOpportunityScan(options = {}) {
  const { pharmacyIds = null, scanType = 'nightly_batch' } = options;

  const batchId = `scan_${Date.now()}_${uuidv4().slice(0, 8)}`;
  const startTime = Date.now();

  logger.info('Starting opportunity scan', { batchId, scanType, pharmacyIds });

  await db.insert('scan_logs', {
    scan_id: uuidv4(),
    scan_batch_id: batchId,
    scan_type: scanType,
    pharmacy_ids: pharmacyIds,
    status: 'running'
  });

  try {
    let pharmacyQuery = `
      SELECT p.pharmacy_id, p.client_id, p.pharmacy_name
      FROM pharmacies p JOIN clients c ON c.client_id = p.client_id
      WHERE p.is_active = true AND c.status IN ('active', 'new', 'onboarding')
    `;
    const params = [];

    if (pharmacyIds?.length > 0) {
      pharmacyQuery += ` AND p.pharmacy_id = ANY($1)`;
      params.push(pharmacyIds);
    }

    const pharmacies = await db.query(pharmacyQuery, params);
    logger.info(`Scanning ${pharmacies.rows.length} pharmacies`, { batchId });

    let totalOpportunities = 0;
    let totalPrescriptions = 0;
    const opportunitiesByType = {};

    for (const pharmacy of pharmacies.rows) {
      const triggerOpps = await scanAdminTriggers(pharmacy.pharmacy_id, batchId);

      // Insert opportunities
      for (const opp of triggerOpps) {
        try {
          await db.insert('opportunities', opp);
          opportunitiesByType[opp.opportunity_type] = (opportunitiesByType[opp.opportunity_type] || 0) + 1;
          totalOpportunities++;
        } catch (error) {
          // Duplicate or constraint error - skip silently
          if (!error.message.includes('duplicate')) {
            logger.error('Failed to insert opportunity', { error: error.message });
          }
        }
      }

      logger.info('Pharmacy scan complete', {
        batchId, pharmacyId: pharmacy.pharmacy_id,
        opportunitiesFound: triggerOpps.length
      });
    }

    const processingTime = Date.now() - startTime;

    await db.query(`
      UPDATE scan_logs SET
        prescriptions_scanned = $1, opportunities_found = $2, opportunities_by_type = $3,
        processing_time_ms = $4, status = 'completed', completed_at = NOW()
      WHERE scan_batch_id = $5
    `, [totalPrescriptions, totalOpportunities, JSON.stringify(opportunitiesByType), processingTime, batchId]);

    logger.info('Opportunity scan completed', { batchId, totalOpportunities, processingTimeMs: processingTime });

    return { batchId, opportunitiesFound: totalOpportunities, opportunitiesByType, processingTimeMs: processingTime };

  } catch (error) {
    logger.error('Opportunity scan failed', { batchId, error: error.message });
    await db.query(`UPDATE scan_logs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE scan_batch_id = $2`, [error.message, batchId]);
    throw error;
  }
}

/**
 * Update patient profiles with inferred conditions from drug history
 */
export async function updatePatientProfiles(pharmacyId) {
  const patients = await db.query(`SELECT DISTINCT patient_id FROM prescriptions WHERE pharmacy_id = $1 AND patient_id IS NOT NULL`, [pharmacyId]);

  for (const { patient_id } of patients.rows) {
    try {
      const meds = await db.query(`SELECT DISTINCT drug_name FROM prescriptions WHERE patient_id = $1 AND dispensed_date >= NOW() - INTERVAL '12 months'`, [patient_id]);

      const drugClasses = new Set();
      for (const med of meds.rows) {
        const cls = detectDrugClass(med.drug_name);
        if (cls) drugClasses.add(cls);
      }

      const conditions = inferConditionsFromDrugs(drugClasses);
      await db.query(`UPDATE patients SET chronic_conditions = $1, updated_at = NOW() WHERE patient_id = $2`, [conditions, patient_id]);
    } catch (error) {
      logger.error('Failed to update patient profile', { patientId: patient_id, error: error.message });
    }
  }
}

export default { runOpportunityScan, updatePatientProfiles, detectDrugClass, inferConditionsFromDrugs };
