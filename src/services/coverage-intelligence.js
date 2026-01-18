/**
 * Coverage Intelligence Service for TheRxOS V2
 *
 * Provides intelligent coverage verification with:
 * - Multi-source CMS formulary fetching
 * - Workability scoring for opportunities
 * - Success/failure tracking and alerting
 * - Auto-retry and fallback mechanisms
 */

import db from '../database/index.js';
import { logger } from '../utils/logger.js';

// Configuration
const CMS_API_BASE = 'https://data.cms.gov/data-api/v1/dataset';
const CMS_FORMULARY_DATASET = process.env.CMS_FORMULARY_DATASET_ID || '92e6c325-eb8e-40a1-9e56-cb66afee89f6';
const API_TIMEOUT = 15000;  // 15 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;   // 1 second base delay

// In-memory cache with TTL
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/**
 * Main entry point - verify coverage for an opportunity
 */
export async function verifyCoverage(opportunityId, options = {}) {
  const startTime = Date.now();
  const { forceRefresh = false, logResult = true } = options;

  try {
    // Get opportunity details
    const opp = await getOpportunityDetails(opportunityId);
    if (!opp) {
      throw new Error(`Opportunity ${opportunityId} not found`);
    }

    // Get patient's insurance info
    const insurance = await getPatientInsurance(opp.patient_id);

    // Try multiple verification sources in order
    let result = null;
    let source = null;

    // 1. Try CMS API if Medicare
    if (insurance.contract_id && insurance.contract_id.match(/^[HSR]\d{4}$/)) {
      result = await tryVerificationSource('cms_api', async () => {
        return await checkCMSFormulary(
          insurance.contract_id,
          insurance.plan_id || '001',
          opp.recommended_ndc
        );
      });
      if (result) source = 'cms_api';
    }

    // 2. Try local formulary cache
    if (!result) {
      result = await tryVerificationSource('local_cache', async () => {
        return await checkLocalFormulary(
          insurance.contract_id,
          insurance.plan_id,
          insurance.bin,
          insurance.pcn,
          opp.recommended_ndc
        );
      });
      if (result) source = 'local_cache';
    }

    // 3. Try 832 pricing data
    if (!result) {
      result = await tryVerificationSource('edi_832', async () => {
        return await check832Data(
          insurance.contract_id,
          opp.recommended_ndc
        );
      });
      if (result) source = 'edi_832';
    }

    // 4. Generate estimate if no data found
    if (!result) {
      result = {
        covered: null,
        tier: null,
        confidence: 'low',
        reason: 'No formulary data available'
      };
      source = 'estimated';
    }

    const responseTime = Date.now() - startTime;

    // Log the verification attempt
    if (logResult) {
      await logVerification({
        opportunityId,
        patientId: opp.patient_id,
        pharmacyId: opp.pharmacy_id,
        ndc: opp.recommended_ndc,
        drugName: opp.recommended_drug,
        contractId: insurance.contract_id,
        planId: insurance.plan_id,
        bin: insurance.bin,
        pcn: insurance.pcn,
        source,
        success: result.covered !== null,
        result,
        responseTime
      });
    }

    // Update opportunity with coverage info
    await updateOpportunityCoverage(opportunityId, result, source);

    return {
      success: true,
      source,
      coverage: result,
      responseTime
    };

  } catch (error) {
    logger.error('Coverage verification failed', { opportunityId, error: error.message });

    // Log the failure
    await logVerification({
      opportunityId,
      success: false,
      errorMessage: error.message,
      responseTime: Date.now() - startTime
    });

    return {
      success: false,
      error: error.message,
      responseTime: Date.now() - startTime
    };
  }
}

/**
 * Batch verify coverage for multiple opportunities
 */
export async function batchVerifyCoverage(opportunityIds, options = {}) {
  const { concurrency = 5 } = options;
  const results = [];
  const errors = [];

  // Process in batches to avoid overwhelming APIs
  for (let i = 0; i < opportunityIds.length; i += concurrency) {
    const batch = opportunityIds.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(id => verifyCoverage(id, options))
    );

    batchResults.forEach((result, idx) => {
      if (result.status === 'fulfilled') {
        results.push({ opportunityId: batch[idx], ...result.value });
      } else {
        errors.push({ opportunityId: batch[idx], error: result.reason.message });
      }
    });
  }

  return { results, errors, total: opportunityIds.length };
}

/**
 * Verify all unverified opportunities for a pharmacy
 */
export async function verifyPharmacyOpportunities(pharmacyId, options = {}) {
  const { limit = 100, status = 'Not Submitted', maxAgeDays = 7 } = options;

  // Get opportunities needing verification
  const query = await db.query(`
    SELECT o.opportunity_id
    FROM opportunities o
    WHERE o.pharmacy_id = $1
      AND o.status = $2
      AND o.recommended_ndc IS NOT NULL
      AND (
        o.coverage_verified = false
        OR o.last_coverage_check IS NULL
        OR o.last_coverage_check < NOW() - ($3 || ' days')::INTERVAL
      )
    ORDER BY o.created_at DESC
    LIMIT $4
  `, [pharmacyId, status, maxAgeDays, limit]);

  const opportunityIds = query.rows.map(r => r.opportunity_id);

  if (opportunityIds.length === 0) {
    return { message: 'No opportunities need verification', verified: 0 };
  }

  const result = await batchVerifyCoverage(opportunityIds, options);

  // Update metrics
  await updateCoverageMetrics(pharmacyId, result);

  return {
    ...result,
    verified: result.results.filter(r => r.success).length,
    failed: result.errors.length
  };
}

/**
 * Calculate workability score for an opportunity
 */
export async function calculateWorkabilityScore(opportunityId) {
  const opp = await getOpportunityDetails(opportunityId);
  if (!opp) {
    throw new Error(`Opportunity ${opportunityId} not found`);
  }

  const scores = {
    coverage: 0,
    margin: 0,
    patient: 0,
    prescriber: 0,
    dataQuality: 0
  };

  const issues = [];
  const missingData = [];
  const warnings = [];
  const blockers = [];

  // 1. COVERAGE SCORE (0-100)
  if (opp.medicare_covered === true) {
    scores.coverage = 80;
    if (opp.medicare_tier <= 2) scores.coverage += 20;  // Preferred tier
    else if (opp.medicare_tier <= 3) scores.coverage += 10;

    if (opp.medicare_prior_auth) {
      scores.coverage -= 20;
      warnings.push('Prior authorization required');
    }
    if (opp.medicare_step_therapy) {
      scores.coverage -= 15;
      warnings.push('Step therapy required');
    }
  } else if (opp.medicare_covered === false) {
    scores.coverage = 10;
    blockers.push('Drug not covered by patient plan');
    issues.push({ type: 'not_covered', severity: 'critical', message: 'Drug not on formulary' });
  } else if (opp.coverage_verified) {
    scores.coverage = 30;
    warnings.push('Coverage status unknown');
  } else {
    scores.coverage = 0;
    missingData.push('coverage_verification');
    issues.push({ type: 'no_coverage_data', severity: 'high', message: 'Coverage not verified' });
  }

  // 2. MARGIN SCORE (0-100)
  if (opp.annual_margin_gain > 0) {
    if (opp.margin_source === '832_data' || opp.margin_source === 'medicare_verified') {
      scores.margin = 90;  // High confidence
    } else if (opp.margin_source === 'acquisition_cost') {
      scores.margin = 70;  // Medium confidence
    } else {
      scores.margin = 40;  // Estimated
      warnings.push('Margin is estimated, not verified');
    }

    // Bonus for high margin
    if (opp.annual_margin_gain >= 500) scores.margin = Math.min(100, scores.margin + 10);
  } else {
    scores.margin = 20;
    issues.push({ type: 'low_margin', severity: 'medium', message: 'No margin gain identified' });
  }

  // 3. PATIENT SCORE (0-100)
  const patientHistory = await getPatientHistory(opp.patient_id);

  if (patientHistory.totalFills > 10) {
    scores.patient = 60;
  } else if (patientHistory.totalFills > 3) {
    scores.patient = 40;
  } else {
    scores.patient = 20;
    warnings.push('Limited patient history');
  }

  // Boost for adherent patients
  if (patientHistory.adherenceRate > 0.8) scores.patient += 30;
  else if (patientHistory.adherenceRate > 0.5) scores.patient += 15;

  // Penalty for patients who refused before
  if (patientHistory.refusedCount > 2) {
    scores.patient -= 20;
    warnings.push('Patient has refused similar recommendations before');
  }

  // 4. PRESCRIBER SCORE (0-100)
  const prescriberStats = await getPrescriberStats(opp.prescriber_npi);

  if (prescriberStats.approvalRate > 0.7) {
    scores.prescriber = 90;
  } else if (prescriberStats.approvalRate > 0.5) {
    scores.prescriber = 70;
  } else if (prescriberStats.approvalRate > 0.3) {
    scores.prescriber = 50;
    warnings.push('Prescriber has moderate approval rate');
  } else if (prescriberStats.totalSubmissions > 5) {
    scores.prescriber = 30;
    issues.push({ type: 'low_prescriber_approval', severity: 'medium', message: 'Prescriber rarely approves changes' });
  } else {
    scores.prescriber = 50;  // Unknown, assume average
  }

  // 5. DATA QUALITY SCORE (0-100)
  let dataPoints = 0;
  let dataTotal = 0;

  // Check required fields
  const requiredFields = ['recommended_ndc', 'current_drug', 'recommended_drug'];
  requiredFields.forEach(field => {
    dataTotal++;
    if (opp[field]) dataPoints++;
    else missingData.push(field);
  });

  // Check optional but helpful fields
  const optionalFields = ['prescriber_npi', 'prescriber_name', 'annual_margin_gain'];
  optionalFields.forEach(field => {
    dataTotal++;
    if (opp[field]) dataPoints++;
  });

  // Check insurance info
  const insuranceFields = ['contract_id', 'bin', 'pcn'];
  const patientInsurance = await getPatientInsurance(opp.patient_id);
  insuranceFields.forEach(field => {
    dataTotal++;
    if (patientInsurance[field]) dataPoints++;
    else missingData.push(`insurance_${field}`);
  });

  scores.dataQuality = Math.round((dataPoints / dataTotal) * 100);

  if (scores.dataQuality < 50) {
    issues.push({ type: 'poor_data_quality', severity: 'high', message: 'Missing critical data fields' });
  }

  // Calculate overall score (weighted average)
  const weights = {
    coverage: 0.35,
    margin: 0.25,
    patient: 0.15,
    prescriber: 0.15,
    dataQuality: 0.10
  };

  const overallScore = Math.round(
    scores.coverage * weights.coverage +
    scores.margin * weights.margin +
    scores.patient * weights.patient +
    scores.prescriber * weights.prescriber +
    scores.dataQuality * weights.dataQuality
  );

  const grade = calculateGrade(overallScore);

  // Determine next action
  let nextAction = 'Ready to submit';
  if (blockers.length > 0) {
    nextAction = 'Blocked - review issues';
  } else if (missingData.includes('coverage_verification')) {
    nextAction = 'Verify coverage first';
  } else if (overallScore < 40) {
    nextAction = 'Low priority - needs review';
  } else if (scores.prescriber < 40) {
    nextAction = 'Consider alternate approach';
  }

  // Save workability score
  await saveWorkabilityScore(opportunityId, {
    workabilityScore: overallScore,
    workabilityGrade: grade,
    coverageScore: scores.coverage,
    marginScore: scores.margin,
    patientScore: scores.patient,
    prescriberScore: scores.prescriber,
    dataQualityScore: scores.dataQuality,
    issues,
    missingData,
    warnings,
    blockers,
    nextAction
  });

  return {
    opportunityId,
    score: overallScore,
    grade,
    scores,
    issues,
    missingData,
    warnings,
    blockers,
    nextAction
  };
}

/**
 * Score all opportunities for a pharmacy
 */
export async function scorePharmacyOpportunities(pharmacyId, options = {}) {
  const { limit = 500, status = 'Not Submitted' } = options;

  const query = await db.query(`
    SELECT o.opportunity_id
    FROM opportunities o
    LEFT JOIN opportunity_workability ow ON ow.opportunity_id = o.opportunity_id
    WHERE o.pharmacy_id = $1
      AND o.status = $2
      AND (ow.scored_at IS NULL OR ow.scored_at < NOW() - INTERVAL '24 hours')
    ORDER BY o.annual_margin_gain DESC NULLS LAST
    LIMIT $3
  `, [pharmacyId, status, limit]);

  const results = { scored: 0, errors: 0, distribution: {} };

  for (const row of query.rows) {
    try {
      const score = await calculateWorkabilityScore(row.opportunity_id);
      results.scored++;
      results.distribution[score.grade] = (results.distribution[score.grade] || 0) + 1;
    } catch (error) {
      logger.error('Workability scoring failed', { opportunityId: row.opportunity_id, error: error.message });
      results.errors++;
    }
  }

  return results;
}

/**
 * Get coverage intelligence dashboard data
 */
export async function getCoverageDashboard(pharmacyId = null) {
  // Get verification success rates
  const successRates = await db.query(`
    SELECT * FROM get_coverage_success_rate($1, 7)
  `, [pharmacyId]);

  // Get workability distribution
  const workability = await db.query(`
    SELECT * FROM get_workability_distribution($1)
  `, [pharmacyId]);

  // Get recent verification issues
  const recentIssues = await db.query(`
    SELECT
      cvl.error_message,
      COUNT(*) as count,
      MAX(cvl.created_at) as last_seen
    FROM coverage_verification_log cvl
    WHERE cvl.verification_success = false
      AND cvl.created_at >= NOW() - INTERVAL '24 hours'
      ${pharmacyId ? 'AND cvl.pharmacy_id = $1' : ''}
    GROUP BY cvl.error_message
    ORDER BY count DESC
    LIMIT 10
  `, pharmacyId ? [pharmacyId] : []);

  // Get opportunities by workability grade
  const opportunitiesByGrade = await db.query(`
    SELECT
      ow.workability_grade,
      COUNT(*) as count,
      SUM(o.annual_margin_gain) as total_margin
    FROM opportunity_workability ow
    JOIN opportunities o ON o.opportunity_id = ow.opportunity_id
    WHERE o.status = 'Not Submitted'
      ${pharmacyId ? 'AND o.pharmacy_id = $1' : ''}
    GROUP BY ow.workability_grade
    ORDER BY ow.workability_grade
  `, pharmacyId ? [pharmacyId] : []);

  // Get coverage source breakdown
  const sourceBreakdown = await db.query(`
    SELECT
      verification_source,
      COUNT(*) as count,
      COUNT(*) FILTER (WHERE is_covered = true) as covered,
      ROUND(AVG(response_time_ms)::NUMERIC) as avg_ms
    FROM coverage_verification_log
    WHERE created_at >= NOW() - INTERVAL '7 days'
      ${pharmacyId ? 'AND pharmacy_id = $1' : ''}
    GROUP BY verification_source
    ORDER BY count DESC
  `, pharmacyId ? [pharmacyId] : []);

  // Check for alerts
  const alerts = [];

  const successRate = successRates.rows[0]?.success_rate || 0;
  if (successRate < 50) {
    alerts.push({
      severity: 'critical',
      message: `Coverage verification success rate is only ${successRate}%`,
      recommendation: 'Check CMS API connectivity and local formulary data'
    });
  } else if (successRate < 80) {
    alerts.push({
      severity: 'warning',
      message: `Coverage verification success rate is ${successRate}%`,
      recommendation: 'Review failed verifications for common patterns'
    });
  }

  const lowWorkabilityPct = workability.rows
    .filter(r => ['D', 'F'].includes(r.grade))
    .reduce((sum, r) => sum + parseFloat(r.pct_of_total || 0), 0);

  if (lowWorkabilityPct > 50) {
    alerts.push({
      severity: 'warning',
      message: `${Math.round(lowWorkabilityPct)}% of opportunities have poor workability scores`,
      recommendation: 'Focus on data quality and coverage verification'
    });
  }

  return {
    successRates: successRates.rows[0] || {},
    workabilityDistribution: workability.rows,
    opportunitiesByGrade: opportunitiesByGrade.rows,
    sourceBreakdown: sourceBreakdown.rows,
    recentIssues: recentIssues.rows,
    alerts,
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Run full coverage intelligence scan
 */
export async function runCoverageIntelligenceScan(options = {}) {
  const { pharmacyId = null, verifyLimit = 200, scoreLimit = 500 } = options;
  const startTime = Date.now();
  const results = {
    pharmacies: [],
    totals: { verified: 0, scored: 0, errors: 0 }
  };

  // Get pharmacies to process
  const pharmacyQuery = pharmacyId
    ? await db.query('SELECT pharmacy_id, pharmacy_name FROM pharmacies WHERE pharmacy_id = $1', [pharmacyId])
    : await db.query(`
        SELECT p.pharmacy_id, p.pharmacy_name
        FROM pharmacies p
        JOIN clients c ON c.client_id = p.client_id
        WHERE c.status = 'active'
        ORDER BY p.pharmacy_name
      `);

  for (const pharmacy of pharmacyQuery.rows) {
    try {
      logger.info('Running coverage intelligence for pharmacy', { pharmacyId: pharmacy.pharmacy_id });

      // Verify coverage
      const verifyResult = await verifyPharmacyOpportunities(pharmacy.pharmacy_id, { limit: verifyLimit });

      // Score workability
      const scoreResult = await scorePharmacyOpportunities(pharmacy.pharmacy_id, { limit: scoreLimit });

      results.pharmacies.push({
        pharmacyId: pharmacy.pharmacy_id,
        pharmacyName: pharmacy.pharmacy_name,
        verified: verifyResult.verified,
        scored: scoreResult.scored,
        errors: verifyResult.failed + scoreResult.errors,
        distribution: scoreResult.distribution
      });

      results.totals.verified += verifyResult.verified;
      results.totals.scored += scoreResult.scored;
      results.totals.errors += verifyResult.failed + scoreResult.errors;

    } catch (error) {
      logger.error('Coverage intelligence failed for pharmacy', {
        pharmacyId: pharmacy.pharmacy_id,
        error: error.message
      });
      results.pharmacies.push({
        pharmacyId: pharmacy.pharmacy_id,
        pharmacyName: pharmacy.pharmacy_name,
        error: error.message
      });
      results.totals.errors++;
    }
  }

  results.duration = Date.now() - startTime;
  logger.info('Coverage intelligence scan complete', results.totals);

  return results;
}

/**
 * Diagnose coverage issues for a specific opportunity
 */
export async function diagnoseCoverageIssues(opportunityId) {
  const opp = await getOpportunityDetails(opportunityId);
  if (!opp) throw new Error('Opportunity not found');

  const diagnosis = {
    opportunityId,
    drug: opp.recommended_drug,
    ndc: opp.recommended_ndc,
    checks: [],
    issues: [],
    recommendations: []
  };

  // Check 1: NDC format
  if (!opp.recommended_ndc) {
    diagnosis.checks.push({ name: 'NDC Present', passed: false });
    diagnosis.issues.push('Missing recommended NDC');
    diagnosis.recommendations.push('Add NDC to trigger definition or drug reference');
  } else if (opp.recommended_ndc.length !== 11) {
    diagnosis.checks.push({ name: 'NDC Format', passed: false, value: opp.recommended_ndc });
    diagnosis.issues.push(`NDC is ${opp.recommended_ndc.length} digits, should be 11`);
    diagnosis.recommendations.push('Normalize NDC to 11-digit format');
  } else {
    diagnosis.checks.push({ name: 'NDC Format', passed: true });
  }

  // Check 2: Patient insurance
  const insurance = await getPatientInsurance(opp.patient_id);

  if (!insurance.contract_id && !insurance.bin) {
    diagnosis.checks.push({ name: 'Insurance Data', passed: false });
    diagnosis.issues.push('No insurance information for patient');
    diagnosis.recommendations.push('Ingest prescription claims with BIN/PCN or contract_id');
  } else {
    diagnosis.checks.push({ name: 'Insurance Data', passed: true, value: insurance });
  }

  // Check 3: CMS API for Medicare
  if (insurance.contract_id?.match(/^[HSR]\d{4}$/)) {
    try {
      const cmsResult = await checkCMSFormulary(
        insurance.contract_id,
        insurance.plan_id || '001',
        opp.recommended_ndc
      );
      if (cmsResult) {
        diagnosis.checks.push({ name: 'CMS API', passed: true, value: cmsResult });
      } else {
        diagnosis.checks.push({ name: 'CMS API', passed: false, value: 'No data returned' });
        diagnosis.issues.push('CMS API did not return coverage data');
        diagnosis.recommendations.push('Check if contract_id and NDC are valid');
      }
    } catch (error) {
      diagnosis.checks.push({ name: 'CMS API', passed: false, value: error.message });
      diagnosis.issues.push(`CMS API error: ${error.message}`);
      diagnosis.recommendations.push('Check API connectivity and rate limits');
    }
  } else {
    diagnosis.checks.push({ name: 'CMS API', passed: null, value: 'Not Medicare plan' });
  }

  // Check 4: Local formulary
  const localFormulary = await checkLocalFormulary(
    insurance.contract_id,
    insurance.plan_id,
    insurance.bin,
    insurance.pcn,
    opp.recommended_ndc
  );

  if (localFormulary) {
    diagnosis.checks.push({ name: 'Local Formulary', passed: true, value: localFormulary });
  } else {
    diagnosis.checks.push({ name: 'Local Formulary', passed: false });
    diagnosis.issues.push('NDC not found in local formulary cache');
    diagnosis.recommendations.push('Load 832 pricing file for this contract or sync CMS data');
  }

  // Check 5: 832 pricing data
  const pricing = await check832Data(insurance.contract_id, opp.recommended_ndc);
  if (pricing) {
    diagnosis.checks.push({ name: '832 Pricing', passed: true, value: pricing });
  } else {
    diagnosis.checks.push({ name: '832 Pricing', passed: false });
    diagnosis.recommendations.push('Load 832 EDI file for this contract');
  }

  // Check 6: Insurance contract mapping
  const contractMapping = await db.query(`
    SELECT * FROM insurance_contracts
    WHERE bin = $1 OR medicare_contract_id = $2
    LIMIT 1
  `, [insurance.bin, insurance.contract_id]);

  if (contractMapping.rows.length > 0) {
    diagnosis.checks.push({ name: 'Contract Mapping', passed: true, value: contractMapping.rows[0] });
  } else {
    diagnosis.checks.push({ name: 'Contract Mapping', passed: false });
    diagnosis.issues.push('No mapping for this BIN/contract');
    diagnosis.recommendations.push('Add insurance contract record for better matching');
  }

  // Summary
  diagnosis.passedChecks = diagnosis.checks.filter(c => c.passed === true).length;
  diagnosis.failedChecks = diagnosis.checks.filter(c => c.passed === false).length;
  diagnosis.overallHealth = diagnosis.failedChecks === 0 ? 'good' :
    diagnosis.failedChecks <= 2 ? 'fair' : 'poor';

  return diagnosis;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

async function getOpportunityDetails(opportunityId) {
  const result = await db.query(`
    SELECT o.*,
      p.first_name as patient_first,
      p.last_name as patient_last
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.opportunity_id = $1
  `, [opportunityId]);
  return result.rows[0];
}

async function getPatientInsurance(patientId) {
  // Get most recent prescription with insurance info
  const result = await db.query(`
    SELECT
      contract_id,
      plan_name as plan_id,
      insurance_bin as bin,
      insurance_pcn as pcn,
      group_number
    FROM prescriptions
    WHERE patient_id = $1
      AND (contract_id IS NOT NULL OR insurance_bin IS NOT NULL)
    ORDER BY dispensed_date DESC
    LIMIT 1
  `, [patientId]);

  return result.rows[0] || {};
}

async function getPatientHistory(patientId) {
  const result = await db.query(`
    SELECT
      COUNT(*) as total_fills,
      COUNT(DISTINCT drug_name) as unique_drugs,
      COUNT(*) FILTER (WHERE dispensed_date >= NOW() - INTERVAL '90 days') as recent_fills
    FROM prescriptions
    WHERE patient_id = $1
  `, [patientId]);

  const refusedResult = await db.query(`
    SELECT COUNT(*) as refused_count
    FROM opportunities
    WHERE patient_id = $1 AND status = 'Declined'
  `, [patientId]);

  const row = result.rows[0];
  return {
    totalFills: parseInt(row?.total_fills || 0),
    uniqueDrugs: parseInt(row?.unique_drugs || 0),
    recentFills: parseInt(row?.recent_fills || 0),
    adherenceRate: row?.recent_fills > 0 ? Math.min(1, row.recent_fills / 3) : 0.5,
    refusedCount: parseInt(refusedResult.rows[0]?.refused_count || 0)
  };
}

async function getPrescriberStats(prescriberNpi) {
  if (!prescriberNpi) return { approvalRate: 0.5, totalSubmissions: 0 };

  const result = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('Submitted', 'Pending', 'Approved', 'Completed')) as total_submissions,
      COUNT(*) FILTER (WHERE status IN ('Approved', 'Completed')) as approved,
      COUNT(*) FILTER (WHERE status = 'Rejected') as rejected
    FROM opportunities
    WHERE prescriber_npi = $1
  `, [prescriberNpi]);

  const row = result.rows[0];
  const totalSubmissions = parseInt(row?.total_submissions || 0);
  const approved = parseInt(row?.approved || 0);

  return {
    totalSubmissions,
    approved,
    rejected: parseInt(row?.rejected || 0),
    approvalRate: totalSubmissions > 0 ? approved / totalSubmissions : 0.5
  };
}

async function tryVerificationSource(sourceName, verifyFn) {
  try {
    return await verifyFn();
  } catch (error) {
    logger.warn(`Verification source ${sourceName} failed`, { error: error.message });
    return null;
  }
}

async function checkCMSFormulary(contractId, planId, ndc) {
  if (!contractId || !ndc) return null;

  const cacheKey = `cms_${contractId}_${planId}_${ndc}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // Format NDC to 11 digits with leading zeros
  const formattedNdc = ndc.replace(/[^0-9]/g, '').padStart(11, '0');

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT);

      const url = `${CMS_API_BASE}/${CMS_FORMULARY_DATASET}/data?` +
        `filter[CONTRACT_ID]=${contractId}&` +
        `filter[PLAN_ID]=${planId}&` +
        `filter[NDC]=${formattedNdc}`;

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`CMS API returned ${response.status}`);
      }

      const data = await response.json();

      if (data && data.length > 0) {
        const item = data[0];
        const result = {
          covered: true,
          tier: parseInt(item.TIER_LEVEL_VALUE) || null,
          tierDescription: getTierDescription(item.TIER_LEVEL_VALUE),
          priorAuth: item.PRIOR_AUTHORIZATION_YN === 'Y',
          stepTherapy: item.STEP_THERAPY_YN === 'Y',
          quantityLimit: item.QUANTITY_LIMIT_YN === 'Y' ? parseInt(item.QUANTITY_LIMIT_AMOUNT) : null,
          confidence: 'high',
          source: 'cms_api'
        };

        cache.set(cacheKey, { data: result, timestamp: Date.now() });
        return result;
      }

      return null;

    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY * (attempt + 1)));
      } else {
        throw error;
      }
    }
  }
}

async function checkLocalFormulary(contractId, planId, bin, pcn, ndc) {
  const result = await db.query(`
    SELECT *
    FROM formulary_items
    WHERE ndc = $1
      AND (
        (contract_id = $2 AND (plan_id = $3 OR plan_id IS NULL))
        OR (bin = $4 AND (pcn = $5 OR pcn IS NULL))
      )
    ORDER BY last_verified_at DESC NULLS LAST
    LIMIT 1
  `, [ndc, contractId, planId, bin, pcn]);

  if (result.rows.length === 0) return null;

  const item = result.rows[0];
  return {
    covered: item.on_formulary,
    tier: item.tier,
    tierDescription: item.tier_description,
    priorAuth: item.prior_auth_required,
    stepTherapy: item.step_therapy_required,
    quantityLimit: item.quantity_limit,
    estimatedCopay: item.estimated_copay,
    reimbursementRate: item.reimbursement_rate,
    confidence: item.verification_status === 'verified' ? 'high' : 'medium',
    source: 'local_cache'
  };
}

async function check832Data(contractId, ndc) {
  if (!ndc) return null;

  const result = await db.query(`
    SELECT *
    FROM drug_pricing
    WHERE ndc = $1
      AND (contract_id = $2 OR contract_id IS NULL)
    ORDER BY effective_date DESC NULLS LAST
    LIMIT 1
  `, [ndc, contractId]);

  if (result.rows.length === 0) return null;

  const item = result.rows[0];
  return {
    covered: true,  // If in 832, it's covered
    reimbursementRate: item.reimbursement_rate,
    wac: item.wac,
    contractPrice: item.contract_price,
    confidence: 'high',
    source: 'edi_832'
  };
}

async function logVerification(data) {
  try {
    await db.query(`
      INSERT INTO coverage_verification_log (
        opportunity_id, patient_id, pharmacy_id,
        ndc, drug_name, contract_id, plan_id, bin, pcn,
        verification_source, verification_success, error_message,
        is_covered, tier, prior_auth, step_therapy, quantity_limit,
        estimated_copay, reimbursement_rate, response_time_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    `, [
      data.opportunityId, data.patientId, data.pharmacyId,
      data.ndc, data.drugName, data.contractId, data.planId, data.bin, data.pcn,
      data.source, data.success, data.errorMessage,
      data.result?.covered, data.result?.tier, data.result?.priorAuth,
      data.result?.stepTherapy, data.result?.quantityLimit,
      data.result?.estimatedCopay, data.result?.reimbursementRate,
      data.responseTime
    ]);
  } catch (error) {
    logger.error('Failed to log verification', { error: error.message });
  }
}

async function updateOpportunityCoverage(opportunityId, result, source) {
  await db.query(`
    UPDATE opportunities SET
      coverage_verified = true,
      coverage_source = $2,
      last_coverage_check = NOW(),
      medicare_covered = $3,
      medicare_tier = $4,
      medicare_prior_auth = $5,
      medicare_step_therapy = $6,
      medicare_quantity_limit = $7,
      medicare_estimated_copay = $8,
      medicare_reimbursement_rate = $9
    WHERE opportunity_id = $1
  `, [
    opportunityId, source, result.covered, result.tier,
    result.priorAuth, result.stepTherapy, result.quantityLimit,
    result.estimatedCopay, result.reimbursementRate
  ]);
}

async function saveWorkabilityScore(opportunityId, data) {
  await db.query(`
    INSERT INTO opportunity_workability (
      opportunity_id, workability_score, workability_grade,
      coverage_score, margin_score, patient_score, prescriber_score, data_quality_score,
      issues, missing_data, warnings, blockers, next_action, scored_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
    ON CONFLICT (opportunity_id) DO UPDATE SET
      workability_score = $2, workability_grade = $3,
      coverage_score = $4, margin_score = $5, patient_score = $6,
      prescriber_score = $7, data_quality_score = $8,
      issues = $9, missing_data = $10, warnings = $11, blockers = $12,
      next_action = $13, scored_at = NOW(), updated_at = NOW()
  `, [
    opportunityId, data.workabilityScore, data.workabilityGrade,
    data.coverageScore, data.marginScore, data.patientScore,
    data.prescriberScore, data.dataQualityScore,
    JSON.stringify(data.issues), data.missingData, data.warnings, data.blockers,
    data.nextAction
  ]);

  // Also update opportunity table for quick access
  await db.query(`
    UPDATE opportunities SET
      workability_score = $2,
      workability_grade = $3
    WHERE opportunity_id = $1
  `, [opportunityId, data.workabilityScore, data.workabilityGrade]);
}

async function updateCoverageMetrics(pharmacyId, result) {
  const today = new Date().toISOString().split('T')[0];

  await db.query(`
    INSERT INTO coverage_intelligence_metrics (
      pharmacy_id, metric_date,
      total_verifications, successful_verifications, failed_verifications,
      covered_count, not_covered_count
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (pharmacy_id, metric_date) DO UPDATE SET
      total_verifications = coverage_intelligence_metrics.total_verifications + $3,
      successful_verifications = coverage_intelligence_metrics.successful_verifications + $4,
      failed_verifications = coverage_intelligence_metrics.failed_verifications + $5,
      covered_count = coverage_intelligence_metrics.covered_count + $6,
      not_covered_count = coverage_intelligence_metrics.not_covered_count + $7
  `, [
    pharmacyId, today,
    result.total,
    result.results?.filter(r => r.success).length || 0,
    result.errors?.length || 0,
    result.results?.filter(r => r.coverage?.covered === true).length || 0,
    result.results?.filter(r => r.coverage?.covered === false).length || 0
  ]);
}

function calculateGrade(score) {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

function getTierDescription(tier) {
  const tiers = {
    '1': 'Preferred Generic',
    '2': 'Generic',
    '3': 'Preferred Brand',
    '4': 'Non-Preferred',
    '5': 'Specialty',
    '6': 'Specialty (High Cost)'
  };
  return tiers[tier] || `Tier ${tier}`;
}

export default {
  verifyCoverage,
  batchVerifyCoverage,
  verifyPharmacyOpportunities,
  calculateWorkabilityScore,
  scorePharmacyOpportunities,
  getCoverageDashboard,
  runCoverageIntelligenceScan,
  diagnoseCoverageIssues
};
