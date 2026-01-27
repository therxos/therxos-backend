/**
 * Coverage Intelligence Routes for TheRxOS V2
 * Provides API endpoints for coverage verification, workability scoring, and monitoring
 */

import express from 'express';
import { authenticateToken } from './auth.js';
import { ROLES } from '../utils/permissions.js';
import coverageIntelligence from '../services/coverage-intelligence.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Middleware to check admin access
function requireAdmin(req, res, next) {
  if (!['super_admin', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Middleware to check super admin
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// ===========================================
// VERIFICATION ENDPOINTS
// ===========================================

// POST /api/coverage/verify/:opportunityId - Verify coverage for single opportunity
router.post('/verify/:opportunityId', authenticateToken, async (req, res) => {
  try {
    const { opportunityId } = req.params;
    const { forceRefresh = false } = req.body;

    const result = await coverageIntelligence.verifyCoverage(opportunityId, { forceRefresh });

    res.json(result);
  } catch (error) {
    logger.error('Verify coverage error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/coverage/verify-batch - Verify coverage for multiple opportunities
router.post('/verify-batch', authenticateToken, async (req, res) => {
  try {
    const { opportunityIds, concurrency = 5 } = req.body;

    if (!opportunityIds || !Array.isArray(opportunityIds)) {
      return res.status(400).json({ error: 'opportunityIds array required' });
    }

    if (opportunityIds.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 opportunities per batch' });
    }

    const result = await coverageIntelligence.batchVerifyCoverage(opportunityIds, { concurrency });

    res.json(result);
  } catch (error) {
    logger.error('Batch verify error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/coverage/verify-pharmacy/:pharmacyId - Verify all opportunities for a pharmacy
router.post('/verify-pharmacy/:pharmacyId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const { limit = 100, status = 'Not Submitted', maxAgeDays = 7 } = req.body;

    const result = await coverageIntelligence.verifyPharmacyOpportunities(pharmacyId, {
      limit: Math.min(limit, 500),
      status,
      maxAgeDays
    });

    res.json(result);
  } catch (error) {
    logger.error('Verify pharmacy error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// WORKABILITY SCORING ENDPOINTS
// ===========================================

// POST /api/coverage/score/:opportunityId - Score single opportunity
router.post('/score/:opportunityId', authenticateToken, async (req, res) => {
  try {
    const { opportunityId } = req.params;

    const result = await coverageIntelligence.calculateWorkabilityScore(opportunityId);

    res.json(result);
  } catch (error) {
    logger.error('Score opportunity error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/coverage/score-pharmacy/:pharmacyId - Score all opportunities for a pharmacy
router.post('/score-pharmacy/:pharmacyId', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const { limit = 500, status = 'Not Submitted' } = req.body;

    const result = await coverageIntelligence.scorePharmacyOpportunities(pharmacyId, {
      limit: Math.min(limit, 1000),
      status
    });

    res.json(result);
  } catch (error) {
    logger.error('Score pharmacy error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// DIAGNOSIS ENDPOINTS
// ===========================================

// GET /api/coverage/diagnose/:opportunityId - Diagnose coverage issues
router.get('/diagnose/:opportunityId', authenticateToken, async (req, res) => {
  try {
    const { opportunityId } = req.params;

    const diagnosis = await coverageIntelligence.diagnoseCoverageIssues(opportunityId);

    res.json(diagnosis);
  } catch (error) {
    logger.error('Diagnose error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// DASHBOARD & MONITORING ENDPOINTS
// ===========================================

// GET /api/coverage/dashboard - Get coverage intelligence dashboard
router.get('/dashboard', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const pharmacyId = req.user.role === ROLES.SUPER_ADMIN ? null : req.user.pharmacyId;

    const dashboard = await coverageIntelligence.getCoverageDashboard(pharmacyId);

    res.json(dashboard);
  } catch (error) {
    logger.error('Dashboard error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/coverage/dashboard/:pharmacyId - Get dashboard for specific pharmacy (super admin)
router.get('/dashboard/:pharmacyId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    const dashboard = await coverageIntelligence.getCoverageDashboard(pharmacyId);

    res.json(dashboard);
  } catch (error) {
    logger.error('Dashboard error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/coverage/scan - Run full coverage intelligence scan (super admin)
router.post('/scan', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId = null, verifyLimit = 200, scoreLimit = 500 } = req.body;

    // This could take a while, so we run it async and return immediately
    const result = await coverageIntelligence.runCoverageIntelligenceScan({
      pharmacyId,
      verifyLimit: Math.min(verifyLimit, 500),
      scoreLimit: Math.min(scoreLimit, 1000)
    });

    res.json(result);
  } catch (error) {
    logger.error('Scan error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// ALERT ENDPOINTS
// ===========================================

// GET /api/coverage/alerts - Get active alerts
router.get('/alerts', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const pharmacyId = req.user.role === ROLES.SUPER_ADMIN ? null : req.user.pharmacyId;
    const dashboard = await coverageIntelligence.getCoverageDashboard(pharmacyId);

    res.json({
      alerts: dashboard.alerts,
      recentIssues: dashboard.recentIssues,
      lastUpdated: dashboard.lastUpdated
    });
  } catch (error) {
    logger.error('Alerts error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// WORKABILITY QUERIES
// ===========================================

// GET /api/coverage/workability/low - Get opportunities with low workability
router.get('/workability/low', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, status = 'Not Submitted' } = req.query;
    const pharmacyId = req.user.role === ROLES.SUPER_ADMIN
      ? req.query.pharmacyId
      : req.user.pharmacyId;

    const db = (await import('../database/index.js')).default;

    const result = await db.query(`
      SELECT
        o.opportunity_id,
        o.patient_id,
        o.current_drug,
        o.recommended_drug,
        o.annual_margin_gain,
        ow.workability_score,
        ow.workability_grade,
        ow.issues,
        ow.missing_data,
        ow.blockers,
        ow.next_action,
        p.first_name || ' ' || p.last_name as patient_name
      FROM opportunities o
      JOIN opportunity_workability ow ON ow.opportunity_id = o.opportunity_id
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      WHERE o.status = $1
        ${pharmacyId ? 'AND o.pharmacy_id = $3' : ''}
        AND ow.workability_grade IN ('D', 'F')
      ORDER BY o.annual_margin_gain DESC NULLS LAST
      LIMIT $2
    `, pharmacyId ? [status, limit, pharmacyId] : [status, limit]);

    res.json({
      opportunities: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    logger.error('Low workability query error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/coverage/workability/high - Get high-workability opportunities ready to submit
router.get('/workability/high', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, status = 'Not Submitted' } = req.query;
    const pharmacyId = req.user.role === ROLES.SUPER_ADMIN
      ? req.query.pharmacyId
      : req.user.pharmacyId;

    const db = (await import('../database/index.js')).default;

    const result = await db.query(`
      SELECT
        o.opportunity_id,
        o.patient_id,
        o.current_drug,
        o.recommended_drug,
        o.annual_margin_gain,
        o.medicare_covered,
        o.medicare_tier,
        ow.workability_score,
        ow.workability_grade,
        ow.next_action,
        p.first_name || ' ' || p.last_name as patient_name
      FROM opportunities o
      JOIN opportunity_workability ow ON ow.opportunity_id = o.opportunity_id
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      WHERE o.status = $1
        ${pharmacyId ? 'AND o.pharmacy_id = $3' : ''}
        AND ow.workability_grade IN ('A', 'B')
        AND (ow.blockers IS NULL OR array_length(ow.blockers, 1) = 0)
      ORDER BY ow.workability_score DESC, o.annual_margin_gain DESC NULLS LAST
      LIMIT $2
    `, pharmacyId ? [status, limit, pharmacyId] : [status, limit]);

    res.json({
      opportunities: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    logger.error('High workability query error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// CMS MEDICARE PART D FORMULARY LOOKUP
// ===========================================

// GET /api/coverage/cms/ndc/:ndc - Look up CMS formulary data for a specific NDC
router.get('/cms/ndc/:ndc', authenticateToken, async (req, res) => {
  try {
    const { ndc } = req.params;
    const db = (await import('../database/index.js')).default;

    // Get all formulary entries for this NDC
    const result = await db.query(`
      SELECT
        cfd.formulary_id,
        cfd.rxcui,
        cfd.ndc,
        cfd.tier_level,
        cfd.prior_authorization_yn as prior_auth_required,
        cfd.step_therapy_yn as step_therapy_required,
        cfd.quantity_limit_yn as quantity_limit,
        cfd.quantity_limit_amount,
        cfd.quantity_limit_days,
        cfd.contract_year,
        cpf.contract_id,
        cpf.plan_id as pbp_id,
        cpf.plan_name
      FROM cms_formulary_drugs cfd
      LEFT JOIN cms_plan_formulary cpf ON cfd.formulary_id = cpf.formulary_id
      WHERE cfd.ndc = $1
      ORDER BY cpf.contract_id, cpf.plan_id
    `, [ndc]);

    if (result.rows.length === 0) {
      return res.json({
        ndc,
        found: false,
        message: 'No CMS formulary data found for this NDC'
      });
    }

    // Calculate summary statistics
    const total = result.rows.length;
    const paRequired = result.rows.filter(r => r.prior_auth_required).length;
    const stRequired = result.rows.filter(r => r.step_therapy_required).length;
    const qlRequired = result.rows.filter(r => r.quantity_limit).length;
    const avgTier = result.rows.reduce((sum, r) => sum + (r.tier_level || 0), 0) / total;

    res.json({
      ndc,
      found: true,
      summary: {
        formulary_count: total,
        average_tier: Math.round(avgTier * 10) / 10,
        prior_auth_rate: Math.round((paRequired / total) * 100),
        step_therapy_rate: Math.round((stRequired / total) * 100),
        quantity_limit_rate: Math.round((qlRequired / total) * 100)
      },
      formularies: result.rows
    });
  } catch (error) {
    logger.error('CMS NDC lookup error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/coverage/cms/batch - Look up CMS formulary data for multiple NDCs
router.post('/cms/batch', authenticateToken, async (req, res) => {
  try {
    const { ndcs } = req.body;

    if (!ndcs || !Array.isArray(ndcs)) {
      return res.status(400).json({ error: 'ndcs array required' });
    }

    if (ndcs.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 NDCs per batch' });
    }

    const db = (await import('../database/index.js')).default;

    // Get aggregated stats for each NDC
    const result = await db.query(`
      SELECT
        ndc,
        COUNT(DISTINCT formulary_id) as formulary_count,
        ROUND(AVG(tier_level)::numeric, 1) as avg_tier,
        SUM(CASE WHEN prior_authorization_yn THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as pa_rate,
        SUM(CASE WHEN step_therapy_yn THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as st_rate,
        SUM(CASE WHEN quantity_limit_yn THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as ql_rate,
        MODE() WITHIN GROUP (ORDER BY quantity_limit_amount) as common_ql_amount,
        MODE() WITHIN GROUP (ORDER BY quantity_limit_days) as common_ql_days
      FROM cms_formulary_drugs
      WHERE ndc = ANY($1)
      GROUP BY ndc
    `, [ndcs]);

    // Build lookup map
    const lookup = new Map();
    for (const row of result.rows) {
      lookup.set(row.ndc, {
        ndc: row.ndc,
        found: true,
        formulary_count: parseInt(row.formulary_count),
        average_tier: parseFloat(row.avg_tier) || null,
        prior_auth_rate: Math.round(parseFloat(row.pa_rate) || 0),
        step_therapy_rate: Math.round(parseFloat(row.st_rate) || 0),
        quantity_limit_rate: Math.round(parseFloat(row.ql_rate) || 0),
        common_quantity_limit: row.common_ql_amount ? `${row.common_ql_amount}/${row.common_ql_days}d` : null
      });
    }

    // Build response including NDCs not found
    const results = ndcs.map(ndc => lookup.get(ndc) || { ndc, found: false });

    res.json({
      total_requested: ndcs.length,
      total_found: result.rows.length,
      results
    });
  } catch (error) {
    logger.error('CMS batch lookup error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/coverage/cms/drug/:drugName - Look up CMS data by drug name pattern
router.get('/cms/drug/:drugName', authenticateToken, async (req, res) => {
  try {
    const { drugName } = req.params;
    const db = (await import('../database/index.js')).default;

    // First find matching NDCs from prescriptions
    const ndcResult = await db.query(`
      SELECT DISTINCT ndc, drug_name
      FROM prescriptions
      WHERE LOWER(drug_name) LIKE $1
        AND ndc IS NOT NULL
      LIMIT 100
    `, [`%${drugName.toLowerCase()}%`]);

    if (ndcResult.rows.length === 0) {
      return res.json({
        drug_name: drugName,
        found: false,
        message: 'No matching prescriptions found for this drug name'
      });
    }

    const ndcs = ndcResult.rows.map(r => r.ndc);

    // Get CMS data for these NDCs
    const cmsResult = await db.query(`
      SELECT
        ndc,
        COUNT(DISTINCT formulary_id) as formulary_count,
        ROUND(AVG(tier_level)::numeric, 1) as avg_tier,
        SUM(CASE WHEN prior_authorization_yn THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as pa_rate,
        SUM(CASE WHEN step_therapy_yn THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as st_rate,
        SUM(CASE WHEN quantity_limit_yn THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as ql_rate
      FROM cms_formulary_drugs
      WHERE ndc = ANY($1)
      GROUP BY ndc
    `, [ndcs]);

    // Map CMS data back to drug names
    const cmsLookup = new Map();
    for (const row of cmsResult.rows) {
      cmsLookup.set(row.ndc, row);
    }

    const drugs = ndcResult.rows.map(rx => {
      const cms = cmsLookup.get(rx.ndc);
      return {
        drug_name: rx.drug_name,
        ndc: rx.ndc,
        cms_data: cms ? {
          formulary_count: parseInt(cms.formulary_count),
          average_tier: parseFloat(cms.avg_tier) || null,
          prior_auth_rate: Math.round(parseFloat(cms.pa_rate) || 0),
          step_therapy_rate: Math.round(parseFloat(cms.st_rate) || 0),
          quantity_limit_rate: Math.round(parseFloat(cms.ql_rate) || 0)
        } : null
      };
    });

    // Calculate overall summary
    const withCms = drugs.filter(d => d.cms_data);
    const summary = withCms.length > 0 ? {
      total_ndcs: drugs.length,
      ndcs_with_cms: withCms.length,
      avg_tier: Math.round(withCms.reduce((sum, d) => sum + (d.cms_data?.average_tier || 0), 0) / withCms.length * 10) / 10,
      avg_pa_rate: Math.round(withCms.reduce((sum, d) => sum + (d.cms_data?.prior_auth_rate || 0), 0) / withCms.length),
      avg_st_rate: Math.round(withCms.reduce((sum, d) => sum + (d.cms_data?.step_therapy_rate || 0), 0) / withCms.length),
      avg_ql_rate: Math.round(withCms.reduce((sum, d) => sum + (d.cms_data?.quantity_limit_rate || 0), 0) / withCms.length)
    } : null;

    res.json({
      drug_name: drugName,
      found: true,
      summary,
      drugs
    });
  } catch (error) {
    logger.error('CMS drug lookup error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/coverage/cms/contract/:contractId - Get formulary info for a specific contract
router.get('/cms/contract/:contractId', authenticateToken, async (req, res) => {
  try {
    const { contractId } = req.params;
    const { drugName } = req.query;
    const db = (await import('../database/index.js')).default;

    // Get plan info
    const planResult = await db.query(`
      SELECT DISTINCT contract_id, plan_id, plan_name, formulary_id
      FROM cms_plan_formulary
      WHERE contract_id = $1
    `, [contractId]);

    if (planResult.rows.length === 0) {
      return res.json({
        contract_id: contractId,
        found: false,
        message: 'No CMS plan data found for this contract'
      });
    }

    const formularyIds = planResult.rows.map(r => r.formulary_id).filter(Boolean);

    // If drug name provided, filter to that drug
    let drugQuery = '';
    let drugParams = [formularyIds];

    if (drugName) {
      // Find NDCs matching the drug name
      const ndcResult = await db.query(`
        SELECT DISTINCT ndc FROM prescriptions
        WHERE LOWER(drug_name) LIKE $1 AND ndc IS NOT NULL
        LIMIT 50
      `, [`%${drugName.toLowerCase()}%`]);

      if (ndcResult.rows.length > 0) {
        drugQuery = ' AND ndc = ANY($2)';
        drugParams.push(ndcResult.rows.map(r => r.ndc));
      }
    }

    // Get drug coverage for this contract's formularies
    const coverageResult = await db.query(`
      SELECT
        formulary_id,
        ndc,
        tier_level,
        prior_authorization_yn as prior_auth,
        step_therapy_yn as step_therapy,
        quantity_limit_yn as quantity_limit,
        quantity_limit_amount,
        quantity_limit_days
      FROM cms_formulary_drugs
      WHERE formulary_id = ANY($1)${drugQuery}
      LIMIT 500
    `, drugParams);

    res.json({
      contract_id: contractId,
      found: true,
      plans: planResult.rows,
      drug_filter: drugName || null,
      coverage_entries: coverageResult.rows.length,
      coverage: coverageResult.rows
    });
  } catch (error) {
    logger.error('CMS contract lookup error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// WORKABILITY QUERIES
// ===========================================

// GET /api/coverage/workability/missing-coverage - Get opportunities missing coverage data
router.get('/workability/missing-coverage', authenticateToken, async (req, res) => {
  try {
    const { limit = 100, status = 'Not Submitted' } = req.query;
    const pharmacyId = req.user.role === ROLES.SUPER_ADMIN
      ? req.query.pharmacyId
      : req.user.pharmacyId;

    const db = (await import('../database/index.js')).default;

    const result = await db.query(`
      SELECT
        o.opportunity_id,
        o.current_drug,
        o.recommended_drug,
        o.recommended_ndc,
        o.annual_margin_gain,
        o.coverage_verified,
        o.last_coverage_check,
        p.first_name || ' ' || p.last_name as patient_name
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      WHERE o.status = $1
        ${pharmacyId ? 'AND o.pharmacy_id = $3' : ''}
        AND (o.coverage_verified = false OR o.coverage_verified IS NULL)
        AND o.recommended_ndc IS NOT NULL
      ORDER BY o.annual_margin_gain DESC NULLS LAST
      LIMIT $2
    `, pharmacyId ? [status, limit, pharmacyId] : [status, limit]);

    res.json({
      opportunities: result.rows,
      total: result.rows.length
    });
  } catch (error) {
    logger.error('Missing coverage query error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;
