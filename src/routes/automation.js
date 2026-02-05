// automation.js - API routes for Gmail polling, Microsoft Graph polling, and automation features
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
import {
  getMicrosoftAuthUrl,
  handleMicrosoftOAuthCallback,
  pollForOutcomesReports,
  pollOneDriveForReports
} from '../services/microsoftPoller.js';
import { scrapeOutcomesEmails } from '../services/outlookScraper.js';
import { scrapeOutcomesHybrid } from '../services/outlookHybridScraper.js';
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
    const frontendUrl = process.env.FRONTEND_URL || 'https://beta.therxos.com';
    res.redirect(`${frontendUrl}/admin?gmail_connected=true`);
  } catch (error) {
    logger.error('Gmail OAuth callback error', { error: error.message });
    const frontendUrl = process.env.FRONTEND_URL || 'https://beta.therxos.com';
    res.redirect(`${frontendUrl}/admin?gmail_error=` + encodeURIComponent(error.message));
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

// ============================================
// Microsoft Graph API Routes (for Outcomes/RX30 emails)
// ============================================

// GET /api/automation/microsoft/auth-url - Get Microsoft OAuth authorization URL
// Temporarily public for re-auth when token expires
router.get('/microsoft/auth-url', async (req, res) => {
  try {
    const authUrl = await getMicrosoftAuthUrl();
    res.json({ authUrl });
  } catch (error) {
    logger.error('Failed to generate Microsoft auth URL', { error: error.message });
    res.status(500).json({ error: 'Failed to generate auth URL: ' + error.message });
  }
});

// GET /api/automation/microsoft/callback - Handle Microsoft OAuth callback
router.get('/microsoft/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      logger.error('Microsoft OAuth error', { error, error_description });
      const frontendUrl = process.env.FRONTEND_URL || 'https://beta.therxos.com';
      return res.redirect(`${frontendUrl}/admin?microsoft_error=${encodeURIComponent(error_description || error)}`);
    }

    if (!code) {
      return res.status(400).json({ error: 'Authorization code required' });
    }

    await handleMicrosoftOAuthCallback(code);

    const frontendUrl = process.env.FRONTEND_URL || 'https://beta.therxos.com';
    res.redirect(`${frontendUrl}/admin?microsoft_connected=true`);
  } catch (error) {
    logger.error('Microsoft OAuth callback error', { error: error.message });
    const frontendUrl = process.env.FRONTEND_URL || 'https://beta.therxos.com';
    res.redirect(`${frontendUrl}/admin?microsoft_error=${encodeURIComponent(error.message)}`);
  }
});

// GET /api/automation/microsoft/status - Check if Microsoft is connected
router.get('/microsoft/status', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT token_data, updated_at FROM system_settings WHERE setting_key = 'microsoft_oauth_tokens'"
    );

    if (result.rows.length === 0) {
      return res.json({ connected: false, lastUpdated: null });
    }

    const tokenData = result.rows[0].token_data;
    const tokens = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

    res.json({
      connected: true,
      lastUpdated: result.rows[0].updated_at,
      account: tokens.account?.username || null
    });
  } catch (error) {
    logger.error('Microsoft status check error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/automation/poll-outcomes - Manually trigger Outcomes email polling
router.post('/poll-outcomes', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, daysBack = 1 } = req.body;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'pharmacyId is required' });
    }

    logger.info('Manual Outcomes poll triggered', { pharmacyId, daysBack, userId: req.user.userId });

    const result = await pollForOutcomesReports({ pharmacyId, daysBack });

    res.json({
      success: true,
      message: 'Outcomes poll completed',
      ...result
    });
  } catch (error) {
    logger.error('Manual Outcomes poll error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/automation/poll-onedrive - Poll OneDrive for Outcomes reports (via Power Automate)
router.post('/poll-onedrive', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, folderPath = '/OutcomesReports', daysBack = 7 } = req.body;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'pharmacyId is required' });
    }

    logger.info('Manual OneDrive poll triggered', { pharmacyId, folderPath, daysBack, userId: req.user.userId });

    const result = await pollOneDriveForReports({ pharmacyId, folderPath, daysBack });

    res.json({
      success: true,
      message: 'OneDrive poll completed',
      ...result
    });
  } catch (error) {
    logger.error('Manual OneDrive poll error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/automation/scrape-outcomes - Trigger Outlook browser scraper for encrypted emails
// NOTE: This only works when running locally with Chrome installed, not on Railway
router.post('/scrape-outcomes', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, daysBack = 7 } = req.body;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'pharmacyId is required' });
    }

    if (!process.env.MICROSOFT_PASSWORD) {
      return res.status(400).json({
        error: 'MICROSOFT_PASSWORD environment variable not set. This scraper requires M365 credentials.'
      });
    }

    logger.info('Outlook scraper triggered', { pharmacyId, daysBack, userId: req.user.userId });

    const result = await scrapeOutcomesEmails({ pharmacyId, daysBack });

    res.json({
      success: true,
      message: 'Outlook scrape completed',
      ...result
    });
  } catch (error) {
    logger.error('Outlook scraper error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// POST /api/automation/scrape-hybrid - Hybrid scraper using Graph API + Puppeteer
// Uses Graph API to find emails, then Puppeteer to navigate to OWA links and download
router.post('/scrape-hybrid', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, daysBack = 7 } = req.body;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'pharmacyId is required' });
    }

    if (!process.env.MICROSOFT_PASSWORD) {
      return res.status(400).json({
        error: 'MICROSOFT_PASSWORD environment variable not set. This scraper requires M365 credentials.'
      });
    }

    logger.info('Hybrid scraper triggered', { pharmacyId, daysBack, userId: req.user.userId });

    const result = await scrapeOutcomesHybrid({ pharmacyId, daysBack });

    res.json({
      success: true,
      message: 'Hybrid scrape completed',
      ...result
    });
  } catch (error) {
    logger.error('Hybrid scraper error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;
