// automation.js - API routes for Gmail polling and automation features
import express from 'express';
import db from '../database/index.js';
import { authenticateToken } from './auth.js';
import { ROLES } from '../utils/permissions.js';
import {
  pollForSPPReports,
  autoCompleteOpportunities,
  getGmailAuthUrl,
  handleGmailOAuthCallback
} from '../services/gmailPoller.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Middleware to check super admin
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// GET /api/automation/gmail/auth-url - Get Gmail OAuth authorization URL
router.get('/gmail/auth-url', authenticateToken, requireSuperAdmin, (req, res) => {
  try {
    const authUrl = getGmailAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    logger.error('Failed to generate Gmail auth URL', { error: error.message });
    res.status(500).json({ error: 'Failed to generate auth URL: ' + error.message });
  }
});

// GET /api/automation/gmail/callback - Handle OAuth callback
router.get('/gmail/callback', async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Authorization code required' });
    }

    await handleGmailOAuthCallback(code);

    // Redirect to admin panel with success message
    res.redirect('/admin?gmail_connected=true');
  } catch (error) {
    logger.error('Gmail OAuth callback error', { error: error.message });
    res.redirect('/admin?gmail_error=' + encodeURIComponent(error.message));
  }
});

// GET /api/automation/gmail/status - Check if Gmail is connected
router.get('/gmail/status', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT updated_at FROM system_settings WHERE setting_key = 'gmail_oauth_tokens'"
    );

    res.json({
      connected: result.rows.length > 0,
      lastUpdated: result.rows[0]?.updated_at || null
    });
  } catch (error) {
    logger.error('Gmail status check error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/automation/poll-spp - Manually trigger SPP email polling
router.post('/poll-spp', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, daysBack = 1 } = req.body;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'pharmacyId is required' });
    }

    logger.info('Manual SPP poll triggered', { pharmacyId, daysBack, userId: req.user.userId });

    const result = await pollForSPPReports({ pharmacyId, daysBack });

    res.json({
      success: true,
      message: 'SPP poll completed',
      ...result
    });
  } catch (error) {
    logger.error('Manual SPP poll error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/automation/auto-complete - Manually trigger auto-completion
router.post('/auto-complete', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.body;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'pharmacyId is required' });
    }

    // Get recent prescriptions for matching
    const recentRx = await db.query(`
      SELECT p.*, pat.first_name as patient_first, pat.last_name as patient_last
      FROM prescriptions p
      LEFT JOIN patients pat ON pat.patient_id = p.patient_id
      WHERE p.pharmacy_id = $1
      AND p.dispensed_date >= NOW() - INTERVAL '7 days'
    `, [pharmacyId]);

    const result = await autoCompleteOpportunities(pharmacyId, recentRx.rows);

    res.json({
      success: true,
      message: 'Auto-complete completed',
      prescriptionsChecked: recentRx.rows.length,
      opportunitiesMatched: result.matched,
      opportunitiesCompleted: result.updated
    });
  } catch (error) {
    logger.error('Auto-complete error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/automation/poll-history - Get poll run history
router.get('/poll-history', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, limit = 20 } = req.query;

    let query = `
      SELECT * FROM poll_runs
      WHERE 1=1
    `;
    const params = [];

    if (pharmacyId) {
      params.push(pharmacyId);
      query += ` AND pharmacy_id = $${params.length}`;
    }

    query += ` ORDER BY started_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json({ runs: result.rows });
  } catch (error) {
    logger.error('Poll history error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// GET /api/automation/settings - Get automation settings
router.get('/settings', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const settings = await db.query(`
      SELECT setting_key,
             CASE WHEN setting_key = 'gmail_oauth_tokens' THEN 'configured'
                  ELSE setting_value END as setting_value,
             updated_at
      FROM system_settings
      WHERE setting_key LIKE 'automation_%' OR setting_key = 'gmail_oauth_tokens'
    `);

    res.json({ settings: settings.rows });
  } catch (error) {
    logger.error('Get settings error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/automation/settings - Update automation settings
router.put('/settings', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { settings } = req.body;

    for (const [key, value] of Object.entries(settings)) {
      await db.query(`
        INSERT INTO system_settings (setting_key, setting_value, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2, updated_at = NOW()
      `, [key, value]);
    }

    res.json({ success: true, message: 'Settings updated' });
  } catch (error) {
    logger.error('Update settings error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;
