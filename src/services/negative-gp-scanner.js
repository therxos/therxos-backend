// Negative GP Opportunity Discovery Scanner
// Scans prescription data for drugs with consistently negative gross profit,
// identifies therapeutic alternatives with positive GP on the same BIN/GROUP,
// and queues findings for admin review via pending_opportunity_types.

import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import scanner from './scanner.js';

const { detectDrugClass } = scanner;

// Regex patterns per therapeutic class (mirrors DRUG_PATTERNS in scanner.js)
// Stored as strings for use in PostgreSQL ~* operator
const CLASS_PATTERNS = {
  statins: 'atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin|fluvastatin|pitavastatin|lipitor|crestor|zocor',
  ace_inhibitors: 'lisinopril|enalapril|ramipril|benazepril|captopril|fosinopril|quinapril|moexipril|perindopril|trandolapril|prinivil|zestril|vasotec|altace',
  arbs: 'losartan|valsartan|irbesartan|olmesartan|candesartan|telmisartan|azilsartan|cozaar|diovan|avapro',
  beta_blockers: 'metoprolol|atenolol|carvedilol|bisoprolol|propranolol|nadolol|nebivolol|labetalol|lopressor|toprol|coreg',
  ccb: 'amlodipine|nifedipine|diltiazem|verapamil|felodipine|nicardipine|norvasc|cardizem|procardia',
  thiazides: 'hydrochlorothiazide|chlorthalidone|indapamide|metolazone|hctz',
  loop_diuretics: 'furosemide|bumetanide|torsemide|lasix|bumex',
  metformin: 'metformin|glucophage|fortamet|glumetza|riomet',
  sulfonylureas: 'glipizide|glyburide|glimepiride|glucotrol|diabeta|micronase|amaryl',
  sglt2: 'canagliflozin|dapagliflozin|empagliflozin|ertugliflozin|invokana|farxiga|jardiance|steglatro',
  glp1: 'semaglutide|liraglutide|dulaglutide|exenatide|ozempic|wegovy|victoza|trulicity|byetta|bydureon',
  dpp4: 'sitagliptin|saxagliptin|linagliptin|alogliptin|januvia|onglyza|tradjenta|nesina',
  insulin: 'insulin|novolog|humalog|lantus|levemir|basaglar|tresiba|toujeo|admelog|fiasp',
  laba: 'salmeterol|formoterol|vilanterol|olodaterol|indacaterol|serevent|foradil',
  lama: 'tiotropium|umeclidinium|aclidinium|glycopyrrolate|spiriva|incruse|tudorza',
  ics: 'fluticasone|budesonide|beclomethasone|mometasone|ciclesonide|flovent|pulmicort|qvar|asmanex|alvesco',
  ics_laba: 'advair|symbicort|breo|dulera|wixela|airduo',
  saba: 'albuterol|levalbuterol|proair|proventil|ventolin|xopenex',
  ssri: 'fluoxetine|sertraline|paroxetine|escitalopram|citalopram|fluvoxamine|prozac|zoloft|paxil|lexapro|celexa',
  snri: 'venlafaxine|duloxetine|desvenlafaxine|levomilnacipran|effexor|cymbalta|pristiq|fetzima',
  benzo: 'alprazolam|lorazepam|clonazepam|diazepam|temazepam|xanax|ativan|klonopin|valium|restoril',
  opioids: 'oxycodone|hydrocodone|morphine|fentanyl|tramadol|codeine|hydromorphone|oxycontin|percocet|vicodin|norco|dilaudid',
  nsaids: 'ibuprofen|naproxen|meloxicam|diclofenac|celecoxib|indomethacin|ketorolac|motrin|advil|aleve|mobic|voltaren|celebrex',
  ppi: 'omeprazole|esomeprazole|lansoprazole|pantoprazole|rabeprazole|dexlansoprazole|prilosec|nexium|prevacid|protonix|aciphex|dexilant',
  thyroid: 'levothyroxine|synthroid|levoxyl|tirosint|unithroid|armour thyroid|liothyronine',
  bisphosphonates: 'alendronate|risedronate|ibandronate|zoledronic|fosamax|actonel|boniva|reclast',
  anticoagulants: 'warfarin|apixaban|rivaroxaban|dabigatran|edoxaban|coumadin|eliquis|xarelto|pradaxa|savaysa',
  glucose_test_strips: 'freestyle|onetouch|one touch|contour|accu-chek|accu chek|true metrix|truemetrix|prodigy|relion|embrace|test strip|blood glucose strip',
  lancets: 'lancet|microlet|unistik',
  pen_needles: 'pen needle|novofine|novotwist|nano pen|bd nano'
};

// Human-readable class names
const CLASS_DISPLAY_NAMES = {
  statins: 'Statins',
  ace_inhibitors: 'ACE Inhibitors',
  arbs: 'ARBs',
  beta_blockers: 'Beta Blockers',
  ccb: 'Calcium Channel Blockers',
  thiazides: 'Thiazide Diuretics',
  loop_diuretics: 'Loop Diuretics',
  metformin: 'Metformin',
  sulfonylureas: 'Sulfonylureas',
  sglt2: 'SGLT2 Inhibitors',
  glp1: 'GLP-1 Agonists',
  dpp4: 'DPP-4 Inhibitors',
  insulin: 'Insulin',
  laba: 'LABA',
  lama: 'LAMA',
  ics: 'Inhaled Corticosteroids',
  ics_laba: 'ICS/LABA Combos',
  saba: 'Short-Acting Beta Agonists',
  ssri: 'SSRIs',
  snri: 'SNRIs',
  benzo: 'Benzodiazepines',
  opioids: 'Opioids',
  nsaids: 'NSAIDs',
  ppi: 'Proton Pump Inhibitors',
  thyroid: 'Thyroid Agents',
  bisphosphonates: 'Bisphosphonates',
  anticoagulants: 'Anticoagulants',
  glucose_test_strips: 'Glucose Test Strips',
  lancets: 'Lancets',
  pen_needles: 'Pen Needles'
};

// Broader therapeutic area groupings for fallback matching
// When same-class matching finds nothing, widen to the therapeutic area
const THERAPEUTIC_AREAS = {
  diabetes: ['metformin', 'sulfonylureas', 'sglt2', 'glp1', 'dpp4', 'insulin'],
  hypertension: ['ace_inhibitors', 'arbs', 'beta_blockers', 'ccb', 'thiazides', 'loop_diuretics'],
  respiratory: ['laba', 'lama', 'ics', 'ics_laba', 'saba'],
  mental_health: ['ssri', 'snri'],
  pain: ['nsaids', 'opioids'],
  gi: ['ppi'],
  cholesterol: ['statins'],
  anticoagulation: ['anticoagulants'],
  bone_health: ['bisphosphonates'],
  thyroid: ['thyroid'],
  diabetic_supplies: ['glucose_test_strips', 'lancets', 'pen_needles']
};

const THERAPEUTIC_AREA_NAMES = {
  diabetes: 'Diabetes Agents',
  hypertension: 'Antihypertensives',
  respiratory: 'Respiratory Agents',
  mental_health: 'Antidepressants',
  pain: 'Pain Management',
  gi: 'GI Agents',
  cholesterol: 'Cholesterol Agents',
  anticoagulation: 'Anticoagulants',
  bone_health: 'Bone Health',
  thyroid: 'Thyroid Agents',
  diabetic_supplies: 'Diabetic Supplies'
};

/**
 * Get the broader therapeutic area pattern for a drug class
 * Returns a combined regex pattern for all classes in the same area
 */
function getBroadPattern(drugClass) {
  for (const [area, classes] of Object.entries(THERAPEUTIC_AREAS)) {
    if (classes.includes(drugClass)) {
      // Combine all class patterns in this area into one regex
      const patterns = classes
        .map(c => CLASS_PATTERNS[c])
        .filter(Boolean);
      return {
        area,
        areaName: THERAPEUTIC_AREA_NAMES[area],
        pattern: patterns.join('|'),
        classes
      };
    }
  }
  return null;
}

// Default thresholds (conservative)
const DEFAULT_THRESHOLDS = {
  minFillsNegative: 3,         // Minimum fills of the negative GP drug
  maxAvgGP: -2.00,             // Must have average GP worse than this
  minFillsAlternative: 2,      // Minimum fills of the positive alternative
  minAvgGPAlternative: 5.00,   // Minimum average GP for alternative
  lookbackDays: 180,           // Look-back period in days
  minMarginGain: 10.00,        // Minimum annual margin gain per patient to report
  maxResults: 50               // Max pending items to create per scan
};

/**
 * Extract base drug name keywords for detection
 */
function extractKeywords(drugName) {
  if (!drugName) return [];
  const baseName = drugName.split(/\s+\d|\s+\(|\s+-/)[0].trim();
  const words = baseName.split(/[\s\-]+/).filter(
    w => w.length >= 3 && !/^\d+$/.test(w) && !['mg', 'ml', 'mcg', 'tab', 'cap', 'tabs', 'caps'].includes(w.toLowerCase())
  );
  return words.map(w => w.toLowerCase()).slice(0, 5);
}

/**
 * Classify a drug into its therapeutic class and return the SQL regex pattern
 */
async function classifyDrug(drugName) {
  // Tier 1: Use DRUG_PATTERNS via detectDrugClass
  const drugClass = detectDrugClass(drugName);
  if (drugClass && CLASS_PATTERNS[drugClass]) {
    return {
      class: drugClass,
      displayName: CLASS_DISPLAY_NAMES[drugClass] || drugClass,
      pattern: CLASS_PATTERNS[drugClass],
      matchTier: 1
    };
  }

  // Tier 2: Check therapeutic_categories table
  try {
    const result = await db.query(`
      SELECT category_name, drug_patterns
      FROM therapeutic_categories
      WHERE EXISTS (
        SELECT 1 FROM unnest(drug_patterns) pattern
        WHERE LOWER($1) LIKE '%' || LOWER(pattern) || '%'
      )
      LIMIT 1
    `, [drugName]);

    if (result.rows.length > 0) {
      const patterns = result.rows[0].drug_patterns;
      return {
        class: result.rows[0].category_name,
        displayName: result.rows[0].category_name,
        pattern: patterns.join('|'),
        matchTier: 2
      };
    }
  } catch (err) {
    // therapeutic_categories table may not exist - that's fine
    logger.debug('therapeutic_categories lookup failed', { error: err.message });
  }

  return null;
}

/**
 * Find all drugs with consistently negative GP, grouped by drug + BIN/GROUP
 */
async function findNegativeGPDrugs(thresholds) {
  const result = await db.query(`
    SELECT
      UPPER(SPLIT_PART(p.drug_name, ' ', 1)) as base_drug_name,
      p.drug_name,
      p.insurance_bin,
      p.insurance_group,
      COUNT(*) as fill_count,
      COUNT(DISTINCT p.patient_id) as patient_count,
      COUNT(DISTINCT p.pharmacy_id) as pharmacy_count,
      ARRAY_AGG(DISTINCT p.pharmacy_id) as pharmacy_ids,
      ROUND(AVG(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      )::numeric, 2) as avg_gp,
      ROUND(SUM(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      )::numeric, 2) as total_loss,
      ROUND(MIN(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      )::numeric, 2) as worst_gp,
      ROUND(MAX(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      )::numeric, 2) as best_gp
    FROM prescriptions p
    JOIN pharmacies ph ON ph.pharmacy_id = p.pharmacy_id
    JOIN clients c ON c.client_id = ph.client_id AND c.status != 'demo'
    WHERE p.dispensed_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      AND p.acquisition_cost IS NOT NULL
      AND p.acquisition_cost > 0
      AND p.insurance_bin IS NOT NULL
      AND p.insurance_bin NOT IN ('000000', '000001', '999999', '')
      AND (p.insurance_group IS NULL OR p.insurance_group NOT IN ('No Group Number', 'NO GROUP', 'NONE', 'N/A', ''))
      AND (p.insurance_pay IS NOT NULL OR p.patient_pay IS NOT NULL)
    GROUP BY UPPER(SPLIT_PART(p.drug_name, ' ', 1)), p.drug_name, p.insurance_bin, p.insurance_group
    HAVING COUNT(*) >= $2
      AND AVG(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      ) <= $3
    ORDER BY SUM(
      COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
    ) ASC
    LIMIT 200
  `, [thresholds.lookbackDays, thresholds.minFillsNegative, thresholds.maxAvgGP]);

  return result.rows;
}

/**
 * Find drugs in the same therapeutic class with positive GP on the same BIN/GROUP
 */
async function findPositiveAlternatives(classPattern, bin, group, baseDrugName, thresholds) {
  const result = await db.query(`
    SELECT
      p.drug_name as alternative_drug,
      COUNT(*) as fill_count,
      COUNT(DISTINCT p.patient_id) as patient_count,
      ROUND(AVG(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      )::numeric, 2) as avg_gp,
      ROUND(MAX(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      )::numeric, 2) as max_gp
    FROM prescriptions p
    WHERE p.dispensed_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      AND p.insurance_bin = $2
      AND ($3::text IS NULL AND p.insurance_group IS NULL OR p.insurance_group = $3)
      AND p.drug_name ~* $4
      AND UPPER(SPLIT_PART(p.drug_name, ' ', 1)) != $5
      AND p.acquisition_cost IS NOT NULL
      AND p.acquisition_cost > 0
    GROUP BY p.drug_name
    HAVING COUNT(*) >= $6
      AND AVG(
        COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
      ) >= $7
    ORDER BY AVG(
      COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric, 0)
    ) DESC
    LIMIT 5
  `, [
    thresholds.lookbackDays,
    bin,
    group || null,
    classPattern,
    baseDrugName,
    thresholds.minFillsAlternative,
    thresholds.minAvgGPAlternative
  ]);

  return result.rows;
}

/**
 * Check if a trigger or pending queue item already covers this drug pair
 */
async function checkExisting(recommendedDrug, currentDrug) {
  // Check if trigger already exists for the recommended drug
  const triggerResult = await db.query(
    `SELECT 1 FROM triggers
     WHERE LOWER(recommended_drug) = LOWER($1) AND is_enabled = true
     LIMIT 1`,
    [recommendedDrug]
  );
  if (triggerResult.rows.length > 0) return true;

  // Check if already exists in approval queue (pending or approved)
  const queueResult = await db.query(
    `SELECT 1 FROM pending_opportunity_types
     WHERE LOWER(recommended_drug_name) = LOWER($1) AND status IN ('pending', 'approved')
     LIMIT 1`,
    [recommendedDrug]
  );
  if (queueResult.rows.length > 0) return true;

  // Also check by detection keywords matching the current drug
  const keywordResult = await db.query(
    `SELECT 1 FROM triggers
     WHERE is_enabled = true
       AND EXISTS (
         SELECT 1 FROM unnest(detection_keywords) kw
         WHERE LOWER($1) LIKE '%' || LOWER(kw) || '%'
       )
       AND LOWER(recommended_drug) LIKE '%' || LOWER(SPLIT_PART($2, ' ', 1)) || '%'
     LIMIT 1`,
    [currentDrug, recommendedDrug]
  );
  if (keywordResult.rows.length > 0) return true;

  return false;
}

/**
 * Enrich a suggestion with coverage verification and claims data
 * Pulls from: actual paid claims, CMS formulary, formulary_items, trigger_bin_values
 */
async function enrichWithCoverageData(recommendedDrug, bin, group, loserDrug) {
  const enrichment = {
    // Actual paid claims for the recommended drug on this BIN/GROUP
    paid_claims: null,
    // Actual paid claims for the loser drug on this BIN/GROUP (the negative GP detail)
    loser_claims: null,
    // CMS formulary coverage for the recommended drug
    cms_coverage: null,
    // Commercial formulary data
    formulary_data: null,
    // Existing trigger coverage verification
    trigger_coverage: null,
    // Estimated GP calculation
    estimated_gp: null,
    coverage_confidence: 'none'
  };

  try {
    // 1. Actual paid claims for the RECOMMENDED drug on this BIN/GROUP
    const recClaims = await db.query(`
      SELECT
        COUNT(*) as claim_count,
        COUNT(DISTINCT patient_id) as patient_count,
        ROUND(AVG(COALESCE(insurance_pay, 0))::numeric, 2) as avg_insurance_pay,
        ROUND(AVG(COALESCE(patient_pay, 0))::numeric, 2) as avg_patient_pay,
        ROUND(AVG(COALESCE(acquisition_cost, 0))::numeric, 2) as avg_acquisition_cost,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as avg_total_reimbursement,
        ROUND(AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0))::numeric, 2) as avg_gp,
        ROUND(MIN(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0))::numeric, 2) as min_gp,
        ROUND(MAX(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0))::numeric, 2) as max_gp,
        MAX(dispensed_date) as last_fill_date
      FROM prescriptions
      WHERE LOWER(drug_name) LIKE LOWER($1)
        AND insurance_bin = $2
        AND ($3::text IS NULL AND insurance_group IS NULL OR insurance_group = $3)
        AND acquisition_cost IS NOT NULL AND acquisition_cost > 0
    `, [`%${recommendedDrug.split(/\s+/)[0]}%`, bin, group || null]);

    if (recClaims.rows[0] && parseInt(recClaims.rows[0].claim_count) > 0) {
      enrichment.paid_claims = {
        claim_count: parseInt(recClaims.rows[0].claim_count),
        patient_count: parseInt(recClaims.rows[0].patient_count),
        avg_insurance_pay: parseFloat(recClaims.rows[0].avg_insurance_pay),
        avg_patient_pay: parseFloat(recClaims.rows[0].avg_patient_pay),
        avg_acquisition_cost: parseFloat(recClaims.rows[0].avg_acquisition_cost),
        avg_total_reimbursement: parseFloat(recClaims.rows[0].avg_total_reimbursement),
        avg_gp: parseFloat(recClaims.rows[0].avg_gp),
        min_gp: parseFloat(recClaims.rows[0].min_gp),
        max_gp: parseFloat(recClaims.rows[0].max_gp),
        last_fill_date: recClaims.rows[0].last_fill_date
      };
      enrichment.coverage_confidence = 'verified_claims';
    }

    // 2. Actual paid claims for the LOSER drug on this BIN/GROUP (so we can show exactly what we're losing)
    const loserClaims = await db.query(`
      SELECT
        COUNT(*) as claim_count,
        ROUND(AVG(COALESCE(insurance_pay, 0))::numeric, 2) as avg_insurance_pay,
        ROUND(AVG(COALESCE(patient_pay, 0))::numeric, 2) as avg_patient_pay,
        ROUND(AVG(COALESCE(acquisition_cost, 0))::numeric, 2) as avg_acquisition_cost,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as avg_total_reimbursement,
        ROUND(AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0))::numeric, 2) as avg_gp
      FROM prescriptions
      WHERE LOWER(drug_name) LIKE LOWER($1)
        AND insurance_bin = $2
        AND ($3::text IS NULL AND insurance_group IS NULL OR insurance_group = $3)
        AND acquisition_cost IS NOT NULL AND acquisition_cost > 0
    `, [`%${loserDrug.split(/\s+/)[0]}%`, bin, group || null]);

    if (loserClaims.rows[0] && parseInt(loserClaims.rows[0].claim_count) > 0) {
      enrichment.loser_claims = {
        claim_count: parseInt(loserClaims.rows[0].claim_count),
        avg_insurance_pay: parseFloat(loserClaims.rows[0].avg_insurance_pay),
        avg_patient_pay: parseFloat(loserClaims.rows[0].avg_patient_pay),
        avg_acquisition_cost: parseFloat(loserClaims.rows[0].avg_acquisition_cost),
        avg_total_reimbursement: parseFloat(loserClaims.rows[0].avg_total_reimbursement),
        avg_gp: parseFloat(loserClaims.rows[0].avg_gp)
      };
    }

    // 3. CMS formulary coverage for the recommended drug
    try {
      const cmsResult = await db.query(`
        SELECT
          cfd.tier_level,
          cfd.prior_authorization_yn,
          cfd.step_therapy_yn,
          cfd.quantity_limit_yn,
          cfd.quantity_limit_amount,
          cfd.quantity_limit_days,
          cpf.plan_name,
          cpf.contract_name
        FROM cms_formulary_drugs cfd
        JOIN cms_plan_formulary cpf ON cpf.formulary_id = cfd.formulary_id
        WHERE cfd.ndc IN (
          SELECT DISTINCT ndc FROM prescriptions
          WHERE LOWER(drug_name) LIKE LOWER($1)
            AND ndc IS NOT NULL
          LIMIT 5
        )
        LIMIT 5
      `, [`%${recommendedDrug.split(/\s+/)[0]}%`]);

      if (cmsResult.rows.length > 0) {
        const row = cmsResult.rows[0];
        enrichment.cms_coverage = {
          covered: true,
          tier: parseInt(row.tier_level),
          tier_label: ['', 'Preferred Generic', 'Generic', 'Preferred Brand', 'Non-Preferred Brand', 'Specialty', 'Specialty High Cost'][parseInt(row.tier_level)] || `Tier ${row.tier_level}`,
          prior_auth: row.prior_authorization_yn === 'Y',
          step_therapy: row.step_therapy_yn === 'Y',
          quantity_limit: row.quantity_limit_yn === 'Y',
          quantity_limit_amount: row.quantity_limit_amount,
          quantity_limit_days: row.quantity_limit_days,
          plan_count: cmsResult.rows.length,
          sample_plan: row.contract_name || row.plan_name
        };
        if (enrichment.coverage_confidence === 'none') {
          enrichment.coverage_confidence = 'cms_formulary';
        }
      }
    } catch (e) {
      // CMS tables may not exist or have data
      logger.debug('CMS lookup failed', { error: e.message });
    }

    // 4. formulary_items for commercial coverage
    try {
      const formularyResult = await db.query(`
        SELECT
          tier, tier_description, preferred, on_formulary,
          prior_auth_required, step_therapy_required,
          estimated_copay, reimbursement_rate,
          data_source, verification_status
        FROM formulary_items
        WHERE (bin = $1 AND (group_number = $2 OR ($2 IS NULL AND group_number IS NULL)))
          AND LOWER(drug_name) LIKE LOWER($3)
        LIMIT 1
      `, [bin, group || null, `%${recommendedDrug.split(/\s+/)[0]}%`]);

      if (formularyResult.rows.length > 0) {
        const f = formularyResult.rows[0];
        enrichment.formulary_data = {
          on_formulary: f.on_formulary,
          tier: f.tier,
          tier_description: f.tier_description,
          preferred: f.preferred,
          prior_auth: f.prior_auth_required,
          step_therapy: f.step_therapy_required,
          estimated_copay: f.estimated_copay ? parseFloat(f.estimated_copay) : null,
          reimbursement_rate: f.reimbursement_rate ? parseFloat(f.reimbursement_rate) : null,
          data_source: f.data_source,
          verified: f.verification_status === 'verified'
        };
        if (enrichment.coverage_confidence === 'none') {
          enrichment.coverage_confidence = 'formulary_cache';
        }
      }
    } catch (e) {
      logger.debug('Formulary lookup failed', { error: e.message });
    }

    // 5. Estimate GP if we have acquisition cost data
    const acqResult = await db.query(`
      SELECT ROUND(AVG(acquisition_cost)::numeric, 2) as avg_acq
      FROM prescriptions
      WHERE LOWER(drug_name) LIKE LOWER($1)
        AND acquisition_cost IS NOT NULL AND acquisition_cost > 0
      LIMIT 1
    `, [`%${recommendedDrug.split(/\s+/)[0]}%`]);

    const avgAcq = acqResult.rows[0]?.avg_acq ? parseFloat(acqResult.rows[0].avg_acq) : null;

    if (avgAcq) {
      let expectedReimbursement = null;
      let reimbursementSource = null;

      if (enrichment.paid_claims) {
        expectedReimbursement = enrichment.paid_claims.avg_total_reimbursement;
        reimbursementSource = 'paid_claims';
      } else if (enrichment.formulary_data?.reimbursement_rate) {
        expectedReimbursement = enrichment.formulary_data.reimbursement_rate;
        reimbursementSource = 'formulary_rate';
      }

      if (expectedReimbursement) {
        enrichment.estimated_gp = {
          avg_acquisition_cost: avgAcq,
          expected_reimbursement: expectedReimbursement,
          estimated_gp_per_fill: parseFloat((expectedReimbursement - avgAcq).toFixed(2)),
          estimated_annual_gp: parseFloat(((expectedReimbursement - avgAcq) * 12).toFixed(2)),
          source: reimbursementSource
        };
      }
    }
  } catch (error) {
    logger.error('Coverage enrichment failed', { drug: recommendedDrug, bin, error: error.message });
  }

  return enrichment;
}

/**
 * Submit a discovered opportunity to the approval queue
 */
async function submitToApprovalQueue({ loser, bestAlternative, classInfo, alternatives, perPatientAnnualGain, matchLevel = 'same_class' }) {
  const recommendedDrugName = bestAlternative.alternative_drug;
  const totalAnnualMargin = perPatientAnnualGain * parseInt(loser.patient_count);

  // Enrich with coverage verification data
  const coverage = await enrichWithCoverageData(
    recommendedDrugName,
    loser.insurance_bin,
    loser.insurance_group,
    loser.drug_name
  );

  const sourceDetails = {
    scan_type: 'negative_gp_discovery',
    scanned_at: new Date().toISOString(),
    // Match context
    match_level: matchLevel, // 'same_class' or 'therapeutic_area'
    broad_area: classInfo.broadArea || null,
    // Loser drug details
    loser_drug: loser.drug_name,
    loser_bin: loser.insurance_bin,
    loser_group: loser.insurance_group,
    loser_avg_gp: parseFloat(loser.avg_gp),
    loser_fill_count: parseInt(loser.fill_count),
    loser_patient_count: parseInt(loser.patient_count),
    loser_total_loss: parseFloat(loser.total_loss),
    loser_worst_gp: parseFloat(loser.worst_gp),
    loser_best_gp: parseFloat(loser.best_gp),
    // Loser claims breakdown (actual reimbursement data)
    loser_claims: coverage.loser_claims,
    // Therapeutic class
    therapeutic_class: classInfo.class,
    therapeutic_class_display: classInfo.displayName,
    match_tier: classInfo.matchTier,
    // Alternative drug details
    alternative_avg_gp: parseFloat(bestAlternative.avg_gp),
    alternative_fill_count: parseInt(bestAlternative.fill_count),
    alternative_patient_count: parseInt(bestAlternative.patient_count),
    per_patient_annual_gain: parseFloat(perPatientAnnualGain.toFixed(2)),
    all_alternatives: alternatives.map(a => ({
      drug: a.alternative_drug,
      avg_gp: parseFloat(a.avg_gp),
      fills: parseInt(a.fill_count),
      patients: parseInt(a.patient_count)
    })),
    // Coverage verification data
    coverage_confidence: coverage.coverage_confidence,
    recommended_paid_claims: coverage.paid_claims,
    cms_coverage: coverage.cms_coverage,
    formulary_data: coverage.formulary_data,
    estimated_gp: coverage.estimated_gp
  };

  const sampleData = {
    current_drugs: [loser.drug_name],
    detection_keywords: extractKeywords(loser.drug_name),
    bin_group: `${loser.insurance_bin}/${loser.insurance_group || 'ALL'}`,
    per_patient_annual_gain: parseFloat(perPatientAnnualGain.toFixed(2))
  };

  await db.query(`
    INSERT INTO pending_opportunity_types (
      pending_type_id,
      recommended_drug_name,
      opportunity_type,
      source,
      source_details,
      sample_data,
      affected_pharmacies,
      total_patient_count,
      estimated_annual_margin,
      created_at,
      updated_at
    ) VALUES (
      gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW()
    )
  `, [
    recommendedDrugName,
    'therapeutic_interchange',
    'negative_gp_scan',
    JSON.stringify(sourceDetails),
    JSON.stringify(sampleData),
    loser.pharmacy_ids,
    parseInt(loser.patient_count),
    parseFloat(totalAnnualMargin.toFixed(2))
  ]);
}

/**
 * Main scan function - finds negative GP drugs and queues alternatives for review
 */
async function scanNegativeGPOpportunities(options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...options };
  const startTime = Date.now();
  const results = {
    losersFound: 0,
    candidatesGenerated: 0,
    submittedToQueue: 0,
    skippedExisting: 0,
    skippedNoClass: 0,
    skippedNoAlternative: 0,
    skippedLowGain: 0,
    errors: [],
    details: [],
    unclassifiedDrugs: [],
    noAlternativeDrugs: [],
    existingTriggerDrugs: [],
    lowGainDrugs: []
  };

  logger.info('Starting Negative GP scan', { thresholds });

  try {
    // Step 1: Find all negative GP drug+BIN/GROUP combinations
    const losers = await findNegativeGPDrugs(thresholds);
    results.losersFound = losers.length;
    logger.info(`Found ${losers.length} negative GP drug/BIN combinations`);

    // Step 2: For each loser, classify and find alternatives
    for (const loser of losers) {
      if (results.submittedToQueue >= thresholds.maxResults) {
        logger.info('Reached maxResults cap', { maxResults: thresholds.maxResults });
        break;
      }

      try {
        // Classify into therapeutic class
        const classInfo = await classifyDrug(loser.drug_name);
        if (!classInfo) {
          results.skippedNoClass++;
          results.unclassifiedDrugs.push({
            drug: loser.drug_name,
            bin: loser.insurance_bin,
            group: loser.insurance_group,
            avgGP: parseFloat(loser.avg_gp),
            fills: parseInt(loser.fill_count),
            patients: parseInt(loser.patient_count),
            totalLoss: parseFloat(loser.total_loss)
          });
          continue;
        }

        // Find positive-GP alternatives in same class + same BIN/GROUP
        let alternatives = await findPositiveAlternatives(
          classInfo.pattern,
          loser.insurance_bin,
          loser.insurance_group,
          loser.base_drug_name,
          thresholds
        );

        let matchLevel = 'same_class';

        // Fallback: if no same-class alternatives, try broader therapeutic area
        if (alternatives.length === 0) {
          const broadInfo = getBroadPattern(classInfo.class);
          if (broadInfo && broadInfo.classes.length > 1) {
            alternatives = await findPositiveAlternatives(
              broadInfo.pattern,
              loser.insurance_bin,
              loser.insurance_group,
              loser.base_drug_name,
              thresholds
            );
            if (alternatives.length > 0) {
              matchLevel = 'therapeutic_area';
              classInfo.broadArea = broadInfo.areaName;
            }
          }
        }

        if (alternatives.length === 0) {
          results.skippedNoAlternative++;
          results.noAlternativeDrugs.push({
            drug: loser.drug_name,
            bin: loser.insurance_bin,
            group: loser.insurance_group,
            avgGP: parseFloat(loser.avg_gp),
            fills: parseInt(loser.fill_count),
            patients: parseInt(loser.patient_count),
            totalLoss: parseFloat(loser.total_loss),
            therapeuticClass: classInfo.displayName
          });
          continue;
        }

        // Pick the best alternative (highest avg_gp)
        const bestAlt = alternatives[0];
        const perPatientAnnualGain = (parseFloat(bestAlt.avg_gp) - parseFloat(loser.avg_gp)) * 12;

        if (perPatientAnnualGain < thresholds.minMarginGain) {
          results.skippedLowGain++;
          results.lowGainDrugs.push({
            drug: loser.drug_name,
            bin: loser.insurance_bin,
            group: loser.insurance_group,
            avgGP: parseFloat(loser.avg_gp),
            recommendedDrug: bestAlt.alternative_drug,
            altAvgGP: parseFloat(bestAlt.avg_gp),
            annualGainPerPatient: parseFloat(perPatientAnnualGain.toFixed(2)),
            therapeuticClass: classInfo.displayName
          });
          continue;
        }

        results.candidatesGenerated++;

        // Check if already covered by existing trigger or queue item
        const alreadyExists = await checkExisting(bestAlt.alternative_drug, loser.drug_name);
        if (alreadyExists) {
          results.skippedExisting++;
          results.existingTriggerDrugs.push({
            drug: loser.drug_name,
            bin: loser.insurance_bin,
            group: loser.insurance_group,
            recommendedDrug: bestAlt.alternative_drug,
            therapeuticClass: classInfo.displayName
          });
          continue;
        }

        // Submit to approval queue
        await submitToApprovalQueue({
          loser,
          bestAlternative: bestAlt,
          classInfo,
          alternatives,
          perPatientAnnualGain,
          matchLevel
        });

        results.submittedToQueue++;
        results.details.push({
          currentDrug: loser.drug_name,
          bin: loser.insurance_bin,
          group: loser.insurance_group,
          avgGP: parseFloat(loser.avg_gp),
          fills: parseInt(loser.fill_count),
          patients: parseInt(loser.patient_count),
          totalLoss: parseFloat(loser.total_loss),
          therapeuticClass: classInfo.displayName,
          broadArea: classInfo.broadArea || null,
          matchLevel,
          recommendedDrug: bestAlt.alternative_drug,
          altAvgGP: parseFloat(bestAlt.avg_gp),
          altFills: parseInt(bestAlt.fill_count),
          estimatedAnnualGainPerPatient: parseFloat(perPatientAnnualGain.toFixed(2)),
          estimatedTotalAnnualGain: parseFloat((perPatientAnnualGain * parseInt(loser.patient_count)).toFixed(2))
        });
      } catch (err) {
        results.errors.push({ drug: loser.drug_name, error: err.message });
        logger.error('Error processing loser drug', { drug: loser.drug_name, error: err.message });
      }
    }

    results.processingTimeMs = Date.now() - startTime;
    logger.info('Negative GP scan completed', {
      losersFound: results.losersFound,
      candidatesGenerated: results.candidatesGenerated,
      submittedToQueue: results.submittedToQueue,
      skippedExisting: results.skippedExisting,
      processingTimeMs: results.processingTimeMs
    });

    return results;
  } catch (error) {
    logger.error('Negative GP scan failed', { error: error.message, stack: error.stack });
    throw error;
  }
}

export { scanNegativeGPOpportunities, findNegativeGPDrugs, DEFAULT_THRESHOLDS };
export default { scanNegativeGPOpportunities, findNegativeGPDrugs, DEFAULT_THRESHOLDS };
