// Opportunity Scanning Engine for TheRxOS V2
// Implements all 4 core opportunity categories:
// 1. NDC Optimization
// 2. Therapeutic Interchange
// 3. Missing Therapy
// 4. RxAudit (Prescription Integrity)

import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

/**
 * Drug class mappings for condition inference
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

/**
 * Drug name patterns for therapeutic class detection
 */
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
  anticoagulants: /warfarin|apixaban|rivaroxaban|dabigatran|edoxaban|coumadin|eliquis|xarelto|pradaxa|savaysa/i
};

/**
 * Detect drug class from drug name
 */
function detectDrugClass(drugName) {
  if (!drugName) return null;
  for (const [drugClass, pattern] of Object.entries(DRUG_PATTERNS)) {
    if (pattern.test(drugName)) {
      return drugClass;
    }
  }
  return null;
}

/**
 * Infer conditions from drug classes
 */
function inferConditionsFromDrugs(drugClasses) {
  const conditions = new Set();
  for (const drugClass of drugClasses) {
    const relatedConditions = DRUG_CLASS_CONDITIONS[drugClass] || [];
    relatedConditions.forEach(c => conditions.add(c));
  }
  return Array.from(conditions);
}

/**
 * NDC Optimization Scanner
 */
async function scanNDCOptimization(pharmacyId, prescriptions, batchId) {
  const opportunities = [];

  for (const rx of prescriptions) {
    try {
      // Skip CASH prescriptions - NDC optimization only applies to insured claims
      if (!rx.insurance_bin || rx.insurance_bin === '' || rx.insurance_bin === 'CASH') continue;

      const currentNDC = await db.query('SELECT * FROM ndc_reference WHERE ndc = $1', [rx.ndc]);
      if (currentNDC.rows.length === 0) continue;

      const current = currentNDC.rows[0];
      if (!current.is_brand && !current.therapeutic_class_code) continue;
      
      const alternatives = await db.query(`
        SELECT * FROM ndc_reference
        WHERE therapeutic_class_code = $1 AND ndc != $2 AND is_active = true AND acquisition_cost IS NOT NULL
        ORDER BY acquisition_cost ASC LIMIT 5
      `, [current.therapeutic_class_code, rx.ndc]);
      
      if (alternatives.rows.length === 0) continue;
      
      const bestAlternative = alternatives.rows[0];
      const currentMargin = (rx.insurance_pay || 0) - (current.acquisition_cost || 0);
      const newMargin = (rx.insurance_pay || 0) - (bestAlternative.acquisition_cost || 0);
      const marginGain = newMargin - currentMargin;
      
      const MIN_MARGIN_GAIN = parseFloat(process.env.MIN_MARGIN_GAIN_THRESHOLD) || 1.00;
      if (marginGain < MIN_MARGIN_GAIN) continue;
      
      const isBrandToGeneric = current.is_brand && !bestAlternative.is_brand;
      
      opportunities.push({
        opportunity_id: uuidv4(),
        prescription_id: rx.prescription_id,
        pharmacy_id: pharmacyId,
        patient_id: rx.patient_id,
        opportunity_type: isBrandToGeneric ? 'brand_to_generic' : 'ndc_optimization',
        current_ndc: rx.ndc,
        current_drug_name: rx.drug_name,
        current_cost: current.acquisition_cost,
        current_margin: currentMargin,
        current_patient_oop: rx.patient_pay,
        recommended_ndc: bestAlternative.ndc,
        recommended_drug_name: bestAlternative.drug_name,
        recommended_cost: bestAlternative.acquisition_cost,
        recommended_margin: newMargin,
        potential_margin_gain: marginGain,
        annual_margin_gain: marginGain * 12,
        clinical_rationale: isBrandToGeneric
          ? `Generic equivalent ${bestAlternative.drug_name} available at lower cost.`
          : `Lower-cost NDC available in same therapeutic class.`,
        clinical_priority: marginGain > 10 ? 'high' : 'medium',
        requires_prescriber_approval: isBrandToGeneric && rx.daw_code !== '0',
        scan_batch_id: batchId,
        status: 'Not Submitted'
      });
    } catch (error) {
      logger.error('NDC optimization scan error', { rxId: rx.prescription_id, error: error.message });
    }
  }
  return opportunities;
}

/**
 * Therapeutic Interchange Scanner
 */
async function scanTherapeuticInterchange(pharmacyId, prescriptions, batchId) {
  const opportunities = [];
  
  for (const rx of prescriptions) {
    try {
      if (!rx.insurance_bin || !rx.insurance_pcn) continue;
      
      const currentClass = detectDrugClass(rx.drug_name);
      if (!currentClass) continue;
      
      const preferredAlternatives = await db.query(`
        SELECT fi.*, nr.*
        FROM formulary_items fi
        JOIN insurance_contracts ic ON ic.contract_id = fi.contract_id
        JOIN ndc_reference nr ON nr.ndc = fi.ndc
        WHERE ic.bin = $1 AND (ic.pcn = $2 OR ic.pcn IS NULL)
        AND nr.therapeutic_class_code = (SELECT therapeutic_class_code FROM ndc_reference WHERE ndc = $3)
        AND fi.ndc != $3 AND fi.preferred = true
        ORDER BY fi.tier ASC, nr.acquisition_cost ASC LIMIT 3
      `, [rx.insurance_bin, rx.insurance_pcn, rx.ndc]);
      
      if (preferredAlternatives.rows.length === 0) continue;
      
      const preferred = preferredAlternatives.rows[0];
      const currentCost = rx.acquisition_cost || 0;
      const newCost = preferred.acquisition_cost || 0;
      const marginGain = (rx.insurance_pay || 0) - newCost - ((rx.insurance_pay || 0) - currentCost);
      const patientSavings = (rx.patient_pay || 0) - (preferred.copay_amount || (rx.patient_pay || 0) * 0.7);
      
      if (marginGain < 1 && patientSavings < 5) continue;
      
      opportunities.push({
        opportunity_id: uuidv4(),
        prescription_id: rx.prescription_id,
        pharmacy_id: pharmacyId,
        patient_id: rx.patient_id,
        opportunity_type: 'therapeutic_interchange',
        current_ndc: rx.ndc,
        current_drug_name: rx.drug_name,
        current_cost: currentCost,
        current_patient_oop: rx.patient_pay,
        recommended_ndc: preferred.ndc,
        recommended_drug_name: preferred.drug_name,
        recommended_cost: newCost,
        recommended_patient_oop: preferred.copay_amount,
        potential_margin_gain: marginGain,
        patient_savings: patientSavings,
        annual_margin_gain: marginGain * 12,
        clinical_rationale: `Formulary-preferred alternative in same therapeutic class. Tier ${preferred.tier}.`,
        clinical_priority: patientSavings > 20 ? 'high' : 'medium',
        requires_prescriber_approval: true,
        scan_batch_id: batchId,
        status: 'Not Submitted'
      });
    } catch (error) {
      logger.error('Therapeutic interchange scan error', { rxId: rx.prescription_id, error: error.message });
    }
  }
  return opportunities;
}

/**
 * Missing Therapy Scanner
 */
async function scanMissingTherapy(pharmacyId, patients, batchId) {
  const opportunities = [];
  const protocols = await db.query('SELECT * FROM clinical_protocols WHERE is_active = true ORDER BY priority ASC');
  
  for (const patient of patients) {
    try {
      const medications = await db.query(`
        SELECT DISTINCT drug_name, ndc, dispensed_date FROM prescriptions
        WHERE patient_id = $1 AND dispensed_date >= NOW() - INTERVAL '12 months'
        ORDER BY dispensed_date DESC
      `, [patient.patient_id]);
      
      if (medications.rows.length === 0) continue;
      
      const patientDrugClasses = new Set();
      for (const med of medications.rows) {
        const drugClass = detectDrugClass(med.drug_name);
        if (drugClass) patientDrugClasses.add(drugClass);
      }
      
      const inferredConditions = inferConditionsFromDrugs(patientDrugClasses);
      
      if (inferredConditions.length > 0) {
        await db.query('UPDATE patients SET chronic_conditions = $1, updated_at = NOW() WHERE patient_id = $2',
          [inferredConditions, patient.patient_id]);
      }
      
      for (const protocol of protocols.rows) {
        const hasTriggerDrugs = protocol.trigger_drug_classes.some(cls => patientDrugClasses.has(cls));
        if (!hasTriggerDrugs) continue;
        
        const hasRecommendedTherapy = medications.rows.some(med => {
          const medClass = detectDrugClass(med.drug_name);
          return medClass === protocol.recommended_drug_class ||
                 med.drug_name.toLowerCase().includes(protocol.recommended_therapy.toLowerCase());
        });
        
        if (hasRecommendedTherapy) continue;
        
        const estimatedMargin = 10;
        
        opportunities.push({
          opportunity_id: uuidv4(),
          pharmacy_id: pharmacyId,
          patient_id: patient.patient_id,
          opportunity_type: 'missing_therapy',
          recommended_drug_name: protocol.recommended_therapy,
          recommended_ndc: protocol.recommended_ndc,
          potential_margin_gain: estimatedMargin,
          annual_margin_gain: estimatedMargin * 12,
          clinical_rationale: protocol.clinical_rationale,
          clinical_priority: protocol.priority <= 2 ? 'high' : protocol.priority <= 4 ? 'medium' : 'low',
          requires_prescriber_approval: true,
          scan_batch_id: batchId,
          status: 'Not Submitted'
        });
      }
    } catch (error) {
      logger.error('Missing therapy scan error', { patientId: patient.patient_id, error: error.message });
    }
  }
  return opportunities;
}

/**
 * RxAudit Scanner
 */
async function scanRxAudit(pharmacyId, prescriptions, batchId) {
  const opportunities = [];
  
  for (const rx of prescriptions) {
    const auditFlags = [];
    
    try {
      const ndcInfo = await db.query('SELECT * FROM ndc_reference WHERE ndc = $1', [rx.ndc]);
      const ndc = ndcInfo.rows[0];
      
      // Brand vs Generic check
      if (ndc?.is_brand) {
        const genericExists = await db.query(`
          SELECT COUNT(*) as count FROM ndc_reference
          WHERE generic_name = $1 AND is_brand = false AND is_active = true
        `, [ndc.generic_name]);
        
        if (parseInt(genericExists.rows[0].count) > 0) {
          if (!rx.daw_code || rx.daw_code === '') {
            auditFlags.push({
              type: 'missing_daw',
              severity: 'warning',
              message: `Brand ${rx.drug_name} dispensed without DAW code. Generic available.`,
              details: { ndc: rx.ndc, drug: rx.drug_name }
            });
          } else if (rx.daw_code === '0') {
            auditFlags.push({
              type: 'brand_with_daw0',
              severity: 'warning',
              message: `DAW 0 but brand dispensed instead of available generic.`,
              details: { ndc: rx.ndc, daw: rx.daw_code }
            });
          }
        }
      }
      
      // Quantity vs Package Size check
      if (ndc?.package_size && rx.quantity_dispensed) {
        const qty = parseFloat(rx.quantity_dispensed);
        const pkgSize = parseInt(ndc.package_size);
        const commonSizes = [30, 60, 90, 100, 120, 180, 28, 14, 7];
        
        if (!commonSizes.includes(qty) && qty % pkgSize !== 0) {
          auditFlags.push({
            type: 'unusual_quantity',
            severity: 'info',
            message: `Quantity ${qty} may not match standard package sizes.`,
            details: { quantity: qty, packageSize: pkgSize }
          });
        }
      }
      
      // Days Supply validation
      if (rx.days_supply && rx.quantity_dispensed && rx.sig) {
        const sig = rx.sig.toLowerCase();
        let expectedDaily = 1;
        
        if (sig.includes('bid') || sig.includes('twice')) expectedDaily = 2;
        else if (sig.includes('tid') || sig.includes('three times')) expectedDaily = 3;
        else if (sig.includes('qid') || sig.includes('four times')) expectedDaily = 4;
        
        const calculatedDays = rx.quantity_dispensed / expectedDaily;
        const variance = Math.abs(calculatedDays - rx.days_supply) / rx.days_supply;
        
        if (variance > 0.2) {
          auditFlags.push({
            type: 'sig_days_mismatch',
            severity: 'warning',
            message: `Days supply (${rx.days_supply}) doesn't match SIG calculation (~${Math.round(calculatedDays)} days).`,
            details: { daysSupply: rx.days_supply, calculatedDays: Math.round(calculatedDays), sig: rx.sig }
          });
        }
      }
      
      // Controlled substance flags
      if (ndc?.is_controlled) {
        auditFlags.push({
          type: 'controlled_substance',
          severity: 'info',
          message: `Controlled substance (Schedule ${ndc.dea_schedule || 'II-V'}) - flagged for compliance review.`,
          details: { ndc: rx.ndc, drug: rx.drug_name, schedule: ndc.dea_schedule }
        });
        
        if (!rx.prescriber_npi) {
          auditFlags.push({
            type: 'missing_prescriber_npi',
            severity: 'critical',
            message: `Controlled substance dispensed without prescriber NPI.`,
            details: { ndc: rx.ndc, drug: rx.drug_name }
          });
        }
      }
      
      // Negative margin check
      if (ndc?.acquisition_cost && ndc.acquisition_cost > 500) {
        const currentMargin = (rx.insurance_pay || 0) - ndc.acquisition_cost;
        if (currentMargin < 0) {
          auditFlags.push({
            type: 'negative_margin',
            severity: 'critical',
            message: `High-cost drug with negative margin. Acquisition: $${ndc.acquisition_cost}, Paid: $${rx.insurance_pay || 0}`,
            details: { acquisitionCost: ndc.acquisition_cost, insurancePay: rx.insurance_pay, margin: currentMargin }
          });
        }
      }
      
      // Create opportunity for critical/warning flags
      for (const flag of auditFlags.filter(f => f.severity !== 'info')) {
        opportunities.push({
          opportunity_id: uuidv4(),
          prescription_id: rx.prescription_id,
          pharmacy_id: pharmacyId,
          patient_id: rx.patient_id,
          opportunity_type: 'audit_flag',
          current_ndc: rx.ndc,
          current_drug_name: rx.drug_name,
          audit_type: flag.type,
          audit_severity: flag.severity,
          audit_details: flag.details,
          potential_margin_gain: 0,
          clinical_rationale: flag.message,
          clinical_priority: flag.severity === 'critical' ? 'critical' : 'high',
          scan_batch_id: batchId,
          status: 'Not Submitted'
        });
      }
    } catch (error) {
      logger.error('RxAudit scan error', { rxId: rx.prescription_id, error: error.message });
    }
  }
  return opportunities;
}

/**
 * Main opportunity scanning function
 */
export async function runOpportunityScan(options = {}) {
  const { pharmacyIds = null, scanType = 'nightly_batch', lookbackHours = 24 } = options;
  
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
      WHERE p.is_active = true AND c.status = 'active'
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
      const prescriptions = await db.query(`
        SELECT * FROM prescriptions
        WHERE pharmacy_id = $1 AND ingestion_date >= NOW() - INTERVAL '${lookbackHours} hours'
        ORDER BY dispensed_date DESC
      `, [pharmacy.pharmacy_id]);
      
      totalPrescriptions += prescriptions.rows.length;
      if (prescriptions.rows.length === 0) continue;
      
      const patientIds = [...new Set(prescriptions.rows.map(r => r.patient_id).filter(Boolean))];
      const patients = await db.query('SELECT * FROM patients WHERE patient_id = ANY($1)', [patientIds]);
      
      const [ndcOpps, interchangeOpps, missingOpps, auditOpps] = await Promise.all([
        scanNDCOptimization(pharmacy.pharmacy_id, prescriptions.rows, batchId),
        scanTherapeuticInterchange(pharmacy.pharmacy_id, prescriptions.rows, batchId),
        scanMissingTherapy(pharmacy.pharmacy_id, patients.rows, batchId),
        scanRxAudit(pharmacy.pharmacy_id, prescriptions.rows, batchId)
      ]);
      
      const allOpportunities = [...ndcOpps, ...interchangeOpps, ...missingOpps, ...auditOpps];
      
      // Deduplicate
      for (const opp of allOpportunities) {
        const existing = await db.query(`
          SELECT opportunity_id FROM opportunities
          WHERE pharmacy_id = $1 AND patient_id = $2 AND opportunity_type = $3
          AND (current_ndc = $4 OR recommended_ndc = $5)
          AND status IN ('Not Submitted', 'Submitted', 'Pending') AND created_at >= NOW() - INTERVAL '30 days'
          LIMIT 1
        `, [opp.pharmacy_id, opp.patient_id, opp.opportunity_type, opp.current_ndc, opp.recommended_ndc]);
        
        if (existing.rows.length === 0) {
          await db.insert('opportunities', opp);
          opportunitiesByType[opp.opportunity_type] = (opportunitiesByType[opp.opportunity_type] || 0) + 1;
          totalOpportunities++;
        }
      }
      
      logger.info('Pharmacy scan complete', {
        batchId, pharmacyId: pharmacy.pharmacy_id,
        prescriptionsScanned: prescriptions.rows.length,
        opportunitiesFound: allOpportunities.length
      });
    }
    
    const processingTime = Date.now() - startTime;
    
    await db.query(`
      UPDATE scan_logs SET
        prescriptions_scanned = $1, opportunities_found = $2, opportunities_by_type = $3,
        processing_time_ms = $4, status = 'completed', completed_at = NOW()
      WHERE scan_batch_id = $5
    `, [totalPrescriptions, totalOpportunities, JSON.stringify(opportunitiesByType), processingTime, batchId]);
    
    logger.info('Opportunity scan completed', { batchId, totalPrescriptions, totalOpportunities, processingTimeMs: processingTime });
    
    return { batchId, prescriptionsScanned: totalPrescriptions, opportunitiesFound: totalOpportunities, opportunitiesByType, processingTimeMs: processingTime };
    
  } catch (error) {
    logger.error('Opportunity scan failed', { batchId, error: error.message });
    await db.query(`UPDATE scan_logs SET status = 'failed', error_message = $1, completed_at = NOW() WHERE scan_batch_id = $2`, [error.message, batchId]);
    throw error;
  }
}

/**
 * Update patient profiles
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

export default { runOpportunityScan, updatePatientProfiles, scanNDCOptimization, scanTherapeuticInterchange, scanMissingTherapy, scanRxAudit, detectDrugClass, inferConditionsFromDrugs };
