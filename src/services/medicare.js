// Medicare Part D Coverage Verification Service
// Uses local CMS formulary database for fast coverage lookups
// Data loaded from CMS SPUF quarterly files (cms_plan_formulary + cms_formulary_drugs tables)

import { logger } from '../utils/logger.js';
import db from '../database/index.js';

// Cache for coverage responses (15 min TTL)
const coverageCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

/**
 * Check if a drug is covered under a Medicare Part D plan
 * Uses local CMS formulary database (cms_plan_formulary + cms_formulary_drugs tables)
 * @param {string} contractId - Medicare contract ID (e.g., H2226)
 * @param {string} planId - Plan benefit package ID (e.g., 001)
 * @param {string} ndc - 11-digit NDC
 * @returns {Object} Coverage details including tier, restrictions, cost
 */
export async function checkMedicareCoverage(contractId, planId, ndc) {
  if (!contractId || !ndc) {
    return { covered: false, reason: 'Missing contract ID or NDC' };
  }

  // Format inputs
  const formattedNdc = ndc.replace(/-/g, '').padStart(11, '0');
  const formattedPlanId = planId ? planId.toString().padStart(3, '0') : null;

  // Check cache first
  const cacheKey = `${contractId}-${formattedPlanId || 'any'}-${formattedNdc}`;
  const cached = coverageCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    // Step 1: Get the formulary_id(s) for this contract/plan from cms_plan_formulary
    let formularyQuery = `
      SELECT DISTINCT formulary_id, plan_name
      FROM cms_plan_formulary
      WHERE contract_id = $1
    `;
    const formularyParams = [contractId];

    if (formattedPlanId) {
      formularyQuery += ` AND plan_id = $2`;
      formularyParams.push(formattedPlanId);
    }

    formularyQuery += ` LIMIT 5`;

    const formularyResult = await db.query(formularyQuery, formularyParams);

    if (formularyResult.rows.length === 0) {
      // Contract/plan not found in our database
      const result = {
        covered: false,
        reason: 'Contract/plan not found',
        contractId,
        planId: formattedPlanId,
        ndc: formattedNdc,
        source: 'cms_local'
      };
      coverageCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }

    // Step 2: Check if the NDC is covered in any of these formularies
    const formularyIds = formularyResult.rows.map(r => r.formulary_id);
    const planName = formularyResult.rows[0].plan_name;

    const coverageResult = await db.query(`
      SELECT
        formulary_id,
        tier_level,
        prior_authorization_yn,
        step_therapy_yn,
        quantity_limit_yn,
        quantity_limit_amount,
        quantity_limit_days,
        rxcui
      FROM cms_formulary_drugs
      WHERE formulary_id = ANY($1)
      AND ndc = $2
      LIMIT 1
    `, [formularyIds, formattedNdc]);

    if (coverageResult.rows.length === 0) {
      // Drug not in any of the plan's formularies
      const result = {
        covered: false,
        reason: 'Not on formulary',
        contractId,
        planId: formattedPlanId,
        planName,
        ndc: formattedNdc,
        tier: null,
        priorAuth: false,
        stepTherapy: false,
        quantityLimit: null,
        source: 'cms_local'
      };
      coverageCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }

    // Drug is covered - build result
    const coverage = coverageResult.rows[0];
    const result = {
      covered: true,
      contractId,
      planId: formattedPlanId,
      planName,
      formularyId: coverage.formulary_id,
      ndc: formattedNdc,
      rxcui: coverage.rxcui,
      tier: coverage.tier_level,
      tierDescription: getTierDescription(coverage.tier_level),
      priorAuth: coverage.prior_authorization_yn === true,
      stepTherapy: coverage.step_therapy_yn === true,
      quantityLimit: coverage.quantity_limit_yn === true ? coverage.quantity_limit_amount : null,
      quantityLimitDays: coverage.quantity_limit_days,
      estimatedCopay: estimateCopayByTier(coverage.tier_level),
      costSharePercentage: getCostShareByTier(coverage.tier_level),
      source: 'cms_local'
    };

    coverageCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;

  } catch (error) {
    logger.error('Medicare coverage check failed', { contractId, planId, ndc, error: error.message });
    return {
      covered: false,
      reason: 'Lookup failed: ' + error.message,
      contractId,
      planId: formattedPlanId,
      ndc: formattedNdc,
      source: 'error'
    };
  }
}

/**
 * Batch check coverage for multiple NDCs under a single plan
 * More efficient when checking multiple drugs for the same patient
 */
export async function batchCheckMedicareCoverage(contractId, planId, ndcs) {
  if (!contractId || !ndcs || ndcs.length === 0) {
    return [];
  }

  const formattedPlanId = planId ? planId.toString().padStart(3, '0') : null;
  const formattedNdcs = ndcs.map(n => n.replace(/-/g, '').padStart(11, '0'));

  try {
    // Get formulary_id(s) for this contract/plan
    let formularyQuery = `
      SELECT DISTINCT formulary_id, plan_name
      FROM cms_plan_formulary
      WHERE contract_id = $1
    `;
    const formularyParams = [contractId];

    if (formattedPlanId) {
      formularyQuery += ` AND plan_id = $2`;
      formularyParams.push(formattedPlanId);
    }

    const formularyResult = await db.query(formularyQuery, formularyParams);

    if (formularyResult.rows.length === 0) {
      return formattedNdcs.map(ndc => ({
        ndc,
        covered: false,
        reason: 'Contract/plan not found'
      }));
    }

    const formularyIds = formularyResult.rows.map(r => r.formulary_id);
    const planName = formularyResult.rows[0].plan_name;

    // Batch query for all NDCs
    const coverageResult = await db.query(`
      SELECT
        ndc,
        formulary_id,
        tier_level,
        prior_authorization_yn,
        step_therapy_yn,
        quantity_limit_yn,
        quantity_limit_amount,
        quantity_limit_days
      FROM cms_formulary_drugs
      WHERE formulary_id = ANY($1)
      AND ndc = ANY($2)
    `, [formularyIds, formattedNdcs]);

    // Create map of covered NDCs
    const coverageMap = new Map();
    for (const row of coverageResult.rows) {
      coverageMap.set(row.ndc, row);
    }

    // Build results for all requested NDCs
    return formattedNdcs.map(ndc => {
      const coverage = coverageMap.get(ndc);
      if (!coverage) {
        return {
          ndc,
          covered: false,
          reason: 'Not on formulary',
          planName
        };
      }
      return {
        ndc,
        covered: true,
        planName,
        tier: coverage.tier_level,
        tierDescription: getTierDescription(coverage.tier_level),
        priorAuth: coverage.prior_authorization_yn === true,
        stepTherapy: coverage.step_therapy_yn === true,
        quantityLimit: coverage.quantity_limit_yn === true ? coverage.quantity_limit_amount : null
      };
    });

  } catch (error) {
    logger.error('Batch Medicare coverage check failed', { contractId, error: error.message });
    return formattedNdcs.map(ndc => ({
      ndc,
      covered: false,
      reason: 'Lookup failed'
    }));
  }
}

/**
 * Get tier description
 */
function getTierDescription(tier) {
  const tiers = {
    '1': 'Preferred Generic',
    '2': 'Generic',
    '3': 'Preferred Brand',
    '4': 'Non-Preferred Brand',
    '5': 'Specialty',
    '6': 'Specialty (High Cost)'
  };
  return tiers[String(tier)] || 'Unknown';
}

/**
 * Estimate copay by tier (2024 standard)
 */
function estimateCopayByTier(tier) {
  const copays = {
    '1': 0,      // Preferred generic - often $0
    '2': 5,      // Generic - $5
    '3': 35,     // Preferred brand - $35
    '4': 95,     // Non-preferred brand - $95
    '5': 95,     // Specialty - 25-33% coinsurance
    '6': 150     // Specialty high - 25-33% coinsurance
  };
  return copays[String(tier)] || 50;
}

/**
 * Get cost share percentage by tier
 */
function getCostShareByTier(tier) {
  const shares = {
    '1': 0,
    '2': 0.25,
    '3': 0.25,
    '4': 0.40,
    '5': 0.25,
    '6': 0.33
  };
  return shares[String(tier)] || 0.25;
}

/**
 * Verify Medicare coverage for all pending opportunities
 * Called by nightly scanner after regular scan completes
 */
export async function verifyOpportunityCoverage(pharmacyId = null) {
  const batchId = `medicare_verify_${Date.now()}`;
  logger.info('Starting Medicare coverage verification', { batchId, pharmacyId });

  try {
    // Get opportunities that need Medicare verification
    // Focus on opportunities where patient has a Medicare Part D plan (contract_id present)
    let query = `
      SELECT DISTINCT ON (o.opportunity_id)
        o.opportunity_id,
        o.pharmacy_id,
        o.patient_id,
        o.recommended_ndc,
        o.recommended_drug_name,
        o.potential_margin_gain,
        o.status,
        p.contract_id,
        p.plan_name,
        pr.insurance_bin,
        pr.insurance_pay
      FROM opportunities o
      JOIN patients pt ON pt.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN (
        SELECT DISTINCT ON (patient_id) patient_id, contract_id, plan_name
        FROM prescriptions
        WHERE contract_id IS NOT NULL
        ORDER BY patient_id, dispensed_date DESC
      ) p ON p.patient_id = o.patient_id
      WHERE o.status = 'Not Submitted'
      AND o.recommended_ndc IS NOT NULL
      AND p.contract_id IS NOT NULL
      AND (o.medicare_verified_at IS NULL OR o.medicare_verified_at < NOW() - INTERVAL '7 days')
    `;

    const params = [];
    if (pharmacyId) {
      query += ` AND o.pharmacy_id = $1`;
      params.push(pharmacyId);
    }

    query += ` LIMIT 500`; // Process in batches

    const opportunities = await db.query(query, params);

    logger.info(`Found ${opportunities.rows.length} opportunities to verify`, { batchId });

    let verified = 0;
    let covered = 0;
    let notCovered = 0;
    let updated = 0;

    for (const opp of opportunities.rows) {
      try {
        // Extract plan ID from plan_name if available (format: "001", "002", etc.)
        const planId = opp.plan_name?.match(/^\d{3}$/)?.[0] || null;

        const coverage = await checkMedicareCoverage(
          opp.contract_id,
          planId,
          opp.recommended_ndc
        );

        verified++;

        // Update opportunity with coverage data
        const updateData = {
          medicare_verified_at: new Date(),
          medicare_covered: coverage.covered,
          medicare_tier: coverage.tier,
          medicare_prior_auth: coverage.priorAuth,
          medicare_step_therapy: coverage.stepTherapy,
          medicare_quantity_limit: coverage.quantityLimit,
          medicare_estimated_copay: coverage.estimatedCopay,
          medicare_reimbursement_rate: coverage.reimbursementRate || null
        };

        // If we have reimbursement data, recalculate margin
        if (coverage.reimbursementRate) {
          // Get acquisition cost for recommended drug
          const ndcInfo = await db.query(
            'SELECT acquisition_cost FROM ndc_reference WHERE ndc = $1',
            [opp.recommended_ndc]
          );

          if (ndcInfo.rows.length > 0) {
            const acquisitionCost = ndcInfo.rows[0].acquisition_cost || 0;
            const actualMargin = coverage.reimbursementRate - acquisitionCost;
            updateData.potential_margin_gain = actualMargin;
            updateData.annual_margin_gain = actualMargin * 12;
            updateData.margin_source = 'medicare_verified';
          }
        }

        await db.query(`
          UPDATE opportunities SET
            medicare_verified_at = $1,
            medicare_covered = $2,
            medicare_tier = $3,
            medicare_prior_auth = $4,
            medicare_step_therapy = $5,
            medicare_quantity_limit = $6,
            medicare_estimated_copay = $7,
            medicare_reimbursement_rate = $8,
            potential_margin_gain = COALESCE($9, potential_margin_gain),
            annual_margin_gain = COALESCE($10, annual_margin_gain),
            margin_source = COALESCE($11, margin_source),
            updated_at = NOW()
          WHERE opportunity_id = $12
        `, [
          updateData.medicare_verified_at,
          updateData.medicare_covered,
          updateData.medicare_tier,
          updateData.medicare_prior_auth,
          updateData.medicare_step_therapy,
          updateData.medicare_quantity_limit,
          updateData.medicare_estimated_copay,
          updateData.medicare_reimbursement_rate,
          updateData.potential_margin_gain,
          updateData.annual_margin_gain,
          updateData.margin_source,
          opp.opportunity_id
        ]);

        if (coverage.covered) {
          covered++;
        } else {
          notCovered++;
        }
        updated++;

        // Small delay to prevent DB connection exhaustion on large batches
        if (updated % 50 === 0) {
          await new Promise(r => setTimeout(r, 10));
        }

      } catch (error) {
        logger.error('Failed to verify opportunity', {
          opportunityId: opp.opportunity_id,
          error: error.message
        });
      }
    }

    logger.info('Medicare coverage verification complete', {
      batchId,
      verified,
      covered,
      notCovered,
      updated
    });

    return { batchId, verified, covered, notCovered, updated };

  } catch (error) {
    logger.error('Medicare verification batch failed', { batchId, error: error.message });
    throw error;
  }
}

/**
 * Lookup CMS reimbursement rate for a drug (30-day supply)
 * Uses Average Sales Price (ASP) data when available
 */
export async function getCMSReimbursementRate(ndc, contractId = null) {
  try {
    // First check if we have 832 pricing data
    const localRate = await db.query(`
      SELECT reimbursement_rate, effective_date, source
      FROM drug_pricing
      WHERE ndc = $1
      AND ($2::text IS NULL OR contract_id = $2)
      AND effective_date <= NOW()
      ORDER BY effective_date DESC
      LIMIT 1
    `, [ndc.replace(/-/g, ''), contractId]);

    if (localRate.rows.length > 0) {
      return {
        rate: parseFloat(localRate.rows[0].reimbursement_rate),
        effectiveDate: localRate.rows[0].effective_date,
        source: localRate.rows[0].source
      };
    }

    // Fallback to NADAC pricing if available
    const nadac = await db.query(`
      SELECT nadac_per_unit, pricing_unit
      FROM nadac_pricing
      WHERE ndc = $1
      ORDER BY effective_date DESC
      LIMIT 1
    `, [ndc.replace(/-/g, '')]);

    if (nadac.rows.length > 0) {
      // Estimate 30-day supply (assume 30 units as baseline)
      const rate = parseFloat(nadac.rows[0].nadac_per_unit) * 30;
      return { rate, source: 'nadac' };
    }

    return null;

  } catch (error) {
    logger.error('CMS reimbursement lookup failed', { ndc, error: error.message });
    return null;
  }
}

/**
 * Find covered alternatives when recommended drug is not covered
 * Uses CMS formulary data to find drugs in the same therapeutic class that are covered
 */
export async function findCoveredAlternatives(contractId, planId, currentNdc, rxcui = null) {
  try {
    const formattedPlanId = planId ? planId.toString().padStart(3, '0') : null;
    const formattedNdc = currentNdc.replace(/-/g, '').padStart(11, '0');

    // Get formulary_id(s) for this contract/plan
    let formularyQuery = `
      SELECT DISTINCT formulary_id
      FROM cms_plan_formulary
      WHERE contract_id = $1
    `;
    const formularyParams = [contractId];

    if (formattedPlanId) {
      formularyQuery += ` AND plan_id = $2`;
      formularyParams.push(formattedPlanId);
    }

    const formularyResult = await db.query(formularyQuery, formularyParams);

    if (formularyResult.rows.length === 0) {
      return [];
    }

    const formularyIds = formularyResult.rows.map(r => r.formulary_id);

    // If we have an RxCUI, try to find other NDCs with the same RxCUI (same drug, different manufacturers)
    if (rxcui) {
      const sameRxcui = await db.query(`
        SELECT DISTINCT
          f.ndc,
          f.tier_level,
          f.prior_authorization_yn,
          f.step_therapy_yn,
          f.quantity_limit_yn,
          f.rxcui
        FROM cms_formulary_drugs f
        WHERE f.formulary_id = ANY($1)
        AND f.rxcui = $2
        AND f.ndc != $3
        ORDER BY f.tier_level ASC
        LIMIT 5
      `, [formularyIds, rxcui, formattedNdc]);

      if (sameRxcui.rows.length > 0) {
        return sameRxcui.rows.map(alt => ({
          ndc: alt.ndc,
          rxcui: alt.rxcui,
          tier: alt.tier_level,
          tierDescription: getTierDescription(alt.tier_level),
          priorAuth: alt.prior_authorization_yn === true,
          stepTherapy: alt.step_therapy_yn === true,
          quantityLimit: alt.quantity_limit_yn === true,
          sameIngredient: true
        }));
      }
    }

    // If no RxCUI-based alternatives, return empty (therapeutic class lookup would require external NDC data)
    return [];

  } catch (error) {
    logger.error('Find alternatives failed', { error: error.message });
    return [];
  }
}

/**
 * Get plan information for a contract
 */
export async function getPlanInfo(contractId, planId = null) {
  try {
    let query = `
      SELECT DISTINCT
        contract_id,
        plan_id,
        plan_name,
        contract_name,
        formulary_id,
        premium,
        deductible
      FROM cms_plan_formulary
      WHERE contract_id = $1
    `;
    const params = [contractId];

    if (planId) {
      query += ` AND plan_id = $2`;
      params.push(planId.toString().padStart(3, '0'));
    }

    query += ` ORDER BY plan_id LIMIT 10`;

    const result = await db.query(query, params);
    return result.rows;

  } catch (error) {
    logger.error('Get plan info failed', { contractId, error: error.message });
    return [];
  }
}

export default {
  checkMedicareCoverage,
  batchCheckMedicareCoverage,
  verifyOpportunityCoverage,
  getCMSReimbursementRate,
  findCoveredAlternatives,
  getPlanInfo
};
