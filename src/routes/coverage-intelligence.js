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
  if (!['super_admin', 'admin', 'owner'].includes(req.user?.role)) {
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
