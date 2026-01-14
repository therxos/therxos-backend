// Medicare Part D Coverage Verification Service
// Uses CMS Formulary API for real-time coverage lookups
// Verifies opportunities have coverage and calculates actual reimbursement

import { logger } from '../utils/logger.js';
import db from '../database/index.js';
import { v4 as uuidv4 } from 'uuid';

// CMS Formulary API endpoints
const CMS_API_BASE = 'https://data.cms.gov/data-api/v1/dataset';
const FORMULARY_DATASET_ID = '9767cb68-8ea9-4f0b-8179-9431abc89f11'; // Part D Formulary dataset

// Cache for API responses (15 min TTL)
const coverageCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

/**
 * Check if a drug is covered under a Medicare Part D plan
 * @param {string} contractId - Medicare contract ID (e.g., H2226)
 * @param {string} planId - Plan benefit package ID (e.g., 001)
 * @param {string} ndc - 11-digit NDC
 * @returns {Object} Coverage details including tier, restrictions, cost
 */
export async function checkMedicareCoverage(contractId, planId, ndc) {
  if (!contractId || !ndc) {
    return { covered: false, reason: 'Missing contract ID or NDC' };
  }

  // Check cache first
  const cacheKey = `${contractId}-${planId || '001'}-${ndc}`;
  const cached = coverageCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    // Format NDC for CMS lookup (remove dashes if present)
    const formattedNdc = ndc.replace(/-/g, '').padStart(11, '0');

    // Query CMS API for formulary data
    const url = `${CMS_API_BASE}/${FORMULARY_DATASET_ID}/data?` + new URLSearchParams({
      'filter[FORMULARY_ID]': contractId,
      'filter[NDC]': formattedNdc,
      'size': '1'
    });

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    if (!response.ok) {
      // If CMS API is unavailable, try our local formulary cache
      return await checkLocalFormulary(contractId, planId, ndc);
    }

    const data = await response.json();

    if (!data.data || data.data.length === 0) {
      // Drug not in formulary - check for therapeutic alternatives
      const result = {
        covered: false,
        reason: 'Not on formulary',
        contractId,
        planId,
        ndc,
        tier: null,
        priorAuth: false,
        stepTherapy: false,
        quantityLimit: null
      };

      coverageCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }

    const formularyEntry = data.data[0];

    const result = {
      covered: true,
      contractId,
      planId: planId || formularyEntry.PBP_ID,
      ndc,
      tier: parseInt(formularyEntry.TIER_LEVEL_VALUE) || null,
      tierDescription: getTierDescription(formularyEntry.TIER_LEVEL_VALUE),
      priorAuth: formularyEntry.PRIOR_AUTHORIZATION_YN === 'Y',
      stepTherapy: formularyEntry.STEP_THERAPY_YN === 'Y',
      quantityLimit: formularyEntry.QUANTITY_LIMIT_YN === 'Y' ? parseFloat(formularyEntry.QUANTITY_LIMIT_AMOUNT) : null,
      quantityLimitDays: formularyEntry.QUANTITY_LIMIT_DAYS ? parseInt(formularyEntry.QUANTITY_LIMIT_DAYS) : null,
      // Estimate patient cost based on tier
      estimatedCopay: estimateCopayByTier(formularyEntry.TIER_LEVEL_VALUE),
      // CMS standard 30-day cost share percentages
      costSharePercentage: getCostShareByTier(formularyEntry.TIER_LEVEL_VALUE)
    };

    coverageCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;

  } catch (error) {
    logger.error('Medicare coverage check failed', { contractId, ndc, error: error.message });
    // Fallback to local formulary on API failure
    return await checkLocalFormulary(contractId, planId, ndc);
  }
}

/**
 * Check our local formulary cache (populated from 832 files or bulk CMS data)
 */
async function checkLocalFormulary(contractId, planId, ndc) {
  try {
    const result = await db.query(`
      SELECT * FROM medicare_formulary
      WHERE contract_id = $1
      AND ($2::text IS NULL OR plan_id = $2)
      AND ndc = $3
      AND (expiration_date IS NULL OR expiration_date > NOW())
      LIMIT 1
    `, [contractId, planId, ndc.replace(/-/g, '')]);

    if (result.rows.length === 0) {
      return { covered: false, reason: 'Not in local formulary', source: 'local' };
    }

    const entry = result.rows[0];
    return {
      covered: true,
      contractId,
      planId: entry.plan_id,
      ndc,
      tier: entry.tier,
      tierDescription: getTierDescription(entry.tier),
      priorAuth: entry.prior_auth_required,
      stepTherapy: entry.step_therapy_required,
      quantityLimit: entry.quantity_limit,
      estimatedCopay: entry.estimated_copay || estimateCopayByTier(entry.tier),
      reimbursementRate: entry.reimbursement_rate, // From 832 data if available
      source: 'local'
    };
  } catch (error) {
    logger.error('Local formulary check failed', { error: error.message });
    return { covered: false, reason: 'Lookup failed', source: 'error' };
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

        // Add small delay to respect API rate limits
        await new Promise(r => setTimeout(r, 100));

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
 */
export async function findCoveredAlternatives(contractId, planId, currentNdc, therapeuticClass) {
  try {
    // Get therapeutic class if not provided
    if (!therapeuticClass) {
      const ndcInfo = await db.query(
        'SELECT therapeutic_class_code FROM ndc_reference WHERE ndc = $1',
        [currentNdc]
      );
      therapeuticClass = ndcInfo.rows[0]?.therapeutic_class_code;
    }

    if (!therapeuticClass) {
      return [];
    }

    // Find covered alternatives in same therapeutic class
    const alternatives = await db.query(`
      SELECT DISTINCT
        mf.ndc,
        nr.drug_name,
        nr.generic_name,
        nr.is_brand,
        mf.tier,
        mf.prior_auth_required,
        mf.reimbursement_rate,
        nr.acquisition_cost
      FROM medicare_formulary mf
      JOIN ndc_reference nr ON nr.ndc = mf.ndc
      WHERE mf.contract_id = $1
      AND nr.therapeutic_class_code = $2
      AND mf.ndc != $3
      AND nr.is_active = true
      ORDER BY mf.tier ASC, nr.acquisition_cost ASC
      LIMIT 5
    `, [contractId, therapeuticClass, currentNdc]);

    return alternatives.rows.map(alt => ({
      ...alt,
      estimatedMargin: alt.reimbursement_rate
        ? alt.reimbursement_rate - (alt.acquisition_cost || 0)
        : null,
      tierDescription: getTierDescription(alt.tier)
    }));

  } catch (error) {
    logger.error('Find alternatives failed', { error: error.message });
    return [];
  }
}

export default {
  checkMedicareCoverage,
  verifyOpportunityCoverage,
  getCMSReimbursementRate,
  findCoveredAlternatives
};
