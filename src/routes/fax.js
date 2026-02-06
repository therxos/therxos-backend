// Fax routes for TheRxOS V2
// Handles fax sending, preflight checks, fax log, stats, and webhooks

import express from 'express';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';
import { hasPermission, PERMISSIONS } from '../utils/permissions.js';
import { formatPatientName, formatPrescriberName } from '../utils/formatters.js';
import { generateFaxDocument } from '../services/faxDocumentGenerator.js';
import {
  preflightCheck,
  sendFax,
  checkFaxStatus,
  handleWebhook,
  getFaxStats,
  getFaxLog
} from '../services/faxService.js';

const router = express.Router();

/**
 * POST /api/fax/preflight
 * Pre-send safety check - returns whether fax can be sent and any warnings
 * Also returns saved fax number from directory if available
 */
router.post('/preflight', authenticateToken, async (req, res) => {
  try {
    const { opportunityId } = req.body;
    const pharmacyId = req.user.pharmacyId;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }
    if (!opportunityId) {
      return res.status(400).json({ error: 'opportunityId is required' });
    }

    // Check user permission
    const settings = await getPharmacySettings(pharmacyId);
    if (!hasPermission(req.user, PERMISSIONS.SEND_FAX_DIRECTLY, settings)) {
      return res.status(403).json({ error: 'You do not have permission to send faxes' });
    }

    const result = await preflightCheck({
      pharmacyId,
      opportunityId,
      prescriberNpi: req.body.prescriberNpi
    });

    res.json(result);
  } catch (error) {
    logger.error('Fax preflight error', { error: error.message });
    res.status(500).json({ error: 'Preflight check failed' });
  }
});

/**
 * POST /api/fax/send
 * Send a fax for an opportunity - auto-updates status to Submitted
 */
router.post('/send', authenticateToken, async (req, res) => {
  try {
    const { opportunityId, prescriberFaxNumber, npiConfirmed } = req.body;
    const pharmacyId = req.user.pharmacyId;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }
    if (!opportunityId) {
      return res.status(400).json({ error: 'opportunityId is required' });
    }
    if (!prescriberFaxNumber) {
      return res.status(400).json({ error: 'prescriberFaxNumber is required' });
    }
    if (!npiConfirmed) {
      return res.status(400).json({ error: 'You must confirm the prescriber NPI before sending' });
    }

    // Check permission
    const settings = await getPharmacySettings(pharmacyId);
    if (!hasPermission(req.user, PERMISSIONS.SEND_FAX_DIRECTLY, settings)) {
      return res.status(403).json({ error: 'You do not have permission to send faxes' });
    }

    // Run preflight check
    const preflight = await preflightCheck({
      pharmacyId,
      opportunityId,
      prescriberNpi: req.body.prescriberNpi
    });

    if (!preflight.canSend) {
      return res.status(400).json({
        error: 'Cannot send fax',
        warnings: preflight.warnings
      });
    }

    // Load full opportunity + patient + pharmacy data for PDF generation
    const oppResult = await db.query(`
      SELECT o.*,
        p.first_name as patient_first_name, p.last_name as patient_last_name,
        p.date_of_birth as patient_dob,
        pr.prescriber_name, pr.prescriber_npi,
        t.clinical_rationale as trigger_rationale
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN triggers t ON t.trigger_id = o.trigger_id
      WHERE o.opportunity_id = $1 AND o.pharmacy_id = $2
    `, [opportunityId, pharmacyId]);

    const opp = oppResult.rows[0];
    if (!opp) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    // Load pharmacy info
    const phResult = await db.query(
      'SELECT pharmacy_name, address, city, state, zip, phone, fax, npi FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );
    const pharmacy = phResult.rows[0];

    const prescriberNpi = req.body.prescriberNpi || opp.prescriber_npi;
    const prescriberName = opp.prescriber_name || 'Prescriber';

    // Use edited content from request, or fall back to opportunity data
    const currentDrugName = req.body.currentDrugName || opp.current_drug_name;
    const recommendedDrugName = req.body.recommendedDrugName || opp.recommended_drug_name;

    // Generate default rationale for missing_therapy/combo_therapy if none provided
    let clinicalRationale = req.body.clinicalRationale || opp.clinical_rationale || opp.trigger_rationale || '';
    if (!clinicalRationale && ['missing_therapy', 'combo_therapy'].includes(opp.opportunity_type)) {
      clinicalRationale = `Patient is currently prescribed ${currentDrugName} but does not have a prescription for ${recommendedDrugName} on file. Please prescribe if clinically appropriate, or complete and return this form to the pharmacy. Thank you.`;
    }

    // Generate the PDF with potentially edited content
    const pdfBuffer = await generateFaxDocument({
      pharmacy,
      prescriber: {
        name: prescriberName,
        npi: prescriberNpi,
        fax_number: prescriberFaxNumber
      },
      patient: {
        first_name: opp.patient_first_name,
        last_name: opp.patient_last_name,
        date_of_birth: opp.patient_dob
      },
      opportunity: {
        current_drug_name: currentDrugName,
        recommended_drug_name: recommendedDrugName,
        opportunity_type: opp.opportunity_type,
        clinical_rationale: clinicalRationale
      }
    });

    // Send via Notifyre
    const result = await sendFax({
      pharmacyId,
      opportunityId,
      prescriberFaxNumber,
      prescriberNpi,
      prescriberName,
      npiConfirmed: true,
      sentBy: req.user.userId,
      pdfBuffer
    });

    logger.info('Fax sent from API', {
      faxLogId: result.faxLogId,
      opportunityId,
      userId: req.user.userId
    });

    res.json({
      success: true,
      faxId: result.faxId,
      faxLogId: result.faxLogId,
      status: result.status,
      message: 'Fax queued for delivery. Opportunity marked as Submitted.'
    });
  } catch (error) {
    logger.error('Fax send error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: `Failed to send fax: ${error.message}` });
  }
});

/**
 * GET /api/fax/log
 * Get fax history for the pharmacy
 */
router.get('/log', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }

    const result = await getFaxLog(pharmacyId, {
      status: req.query.status,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      prescriberNpi: req.query.prescriberNpi,
      limit: req.query.limit,
      offset: req.query.offset
    });

    // Format names for display
    result.faxes = result.faxes.map(fax => ({
      ...fax,
      patient_name: formatPatientName(fax.patient_first_name, fax.patient_last_name),
      sender_name: formatPatientName(fax.sender_first_name, fax.sender_last_name),
      prescriber_name_formatted: formatPrescriberName(fax.prescriber_name)
    }));

    res.json(result);
  } catch (error) {
    logger.error('Fax log error', { error: error.message });
    res.status(500).json({ error: 'Failed to get fax log' });
  }
});

/**
 * GET /api/fax/stats
 * Get fax statistics for the pharmacy
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }

    const days = parseInt(req.query.days) || 30;
    const stats = await getFaxStats(pharmacyId, days);
    res.json(stats);
  } catch (error) {
    logger.error('Fax stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get fax stats' });
  }
});

/**
 * GET /api/fax/queue
 * Get pending/queued faxes for the pharmacy with ETA information
 */
router.get('/queue', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }

    // Include failed faxes from last 24 hours so user can resend
    const result = await db.query(`
      SELECT fl.fax_id, fl.fax_status, fl.created_at, fl.prescriber_name,
             fl.prescriber_fax_number, fl.notifyre_fax_id, fl.failed_reason,
             fl.current_drug, fl.recommended_drug, fl.opportunity_id,
             p.first_name as patient_first, p.last_name as patient_last
      FROM fax_log fl
      LEFT JOIN patients p ON p.patient_id = fl.patient_id
      WHERE fl.pharmacy_id = $1
        AND (
          fl.fax_status IN ('queued', 'sending', 'accepted', 'in_progress')
          OR (fl.fax_status = 'failed' AND fl.created_at > NOW() - INTERVAL '24 hours')
        )
      ORDER BY fl.created_at DESC
    `, [pharmacyId]);

    // Add ETA, status description, and resend capability
    const faxes = result.rows.map(f => {
      const minutesSinceSent = Math.round((Date.now() - new Date(f.created_at).getTime()) / 60000);
      let statusDescription = '';
      let eta = '';
      let canResend = false;

      switch (f.fax_status) {
        case 'queued':
          statusDescription = 'Waiting to be processed by fax service';
          eta = minutesSinceSent < 5 ? 'Should deliver within 1-5 minutes' : 'Processing may be delayed';
          canResend = minutesSinceSent > 10; // Allow resend if stuck for 10+ minutes
          break;
        case 'sending':
          statusDescription = 'Currently being transmitted';
          eta = 'Should complete within 1-2 minutes';
          break;
        case 'in_progress':
          statusDescription = 'Transmission in progress';
          eta = 'Should complete shortly';
          break;
        case 'failed':
          statusDescription = f.failed_reason || 'Fax delivery failed';
          eta = 'Click Resend to try again';
          canResend = true;
          break;
        default:
          statusDescription = 'Processing';
          eta = 'Check back soon';
      }

      return {
        ...f,
        patient_name: f.patient_first && f.patient_last
          ? `${f.patient_first} ${f.patient_last}` : 'Unknown',
        minutes_since_sent: minutesSinceSent,
        status_description: statusDescription,
        eta: eta,
        can_resend: canResend
      };
    });

    res.json({
      pending_count: faxes.length,
      faxes: faxes
    });
  } catch (error) {
    logger.error('Fax queue error', { error: error.message });
    res.status(500).json({ error: 'Failed to get fax queue' });
  }
});

/**
 * POST /api/fax/:faxId/resend
 * Reset a failed fax so user can resend it
 */
router.post('/:faxId/resend', authenticateToken, async (req, res) => {
  try {
    const { faxId } = req.params;
    const pharmacyId = req.user.pharmacyId;

    // Get the failed fax
    const faxResult = await db.query(`
      SELECT * FROM fax_log WHERE fax_id = $1 AND pharmacy_id = $2
    `, [faxId, pharmacyId]);

    if (faxResult.rows.length === 0) {
      return res.status(404).json({ error: 'Fax not found' });
    }

    const fax = faxResult.rows[0];

    if (!['failed', 'queued', 'resent', 'cancelled', 'no_answer', 'busy'].includes(fax.fax_status)) {
      return res.status(400).json({ error: 'Only failed or stuck faxes can be resent' });
    }

    // Reset the opportunity to Not Submitted so they can fax again
    if (fax.opportunity_id) {
      await db.query(`
        UPDATE opportunities SET
          status = 'Not Submitted',
          updated_at = NOW()
        WHERE opportunity_id = $1
      `, [fax.opportunity_id]);
    }

    // Mark old fax as resent
    await db.query(`
      UPDATE fax_log SET
        fax_status = 'resent',
        failed_reason = COALESCE(failed_reason, '') || ' - Resend requested',
        updated_at = NOW()
      WHERE fax_id = $1
    `, [faxId]);

    logger.info('Fax reset for resend', { faxId, opportunityId: fax.opportunity_id, userId: req.user.userId });

    res.json({
      success: true,
      message: 'Fax reset. You can now resend from the opportunity.',
      opportunity_id: fax.opportunity_id
    });
  } catch (error) {
    logger.error('Fax resend error', { error: error.message });
    res.status(500).json({ error: 'Failed to reset fax for resend' });
  }
});

/**
 * GET /api/fax/:faxId
 * Get single fax detail
 */
router.get('/:faxId', authenticateToken, async (req, res) => {
  try {
    const { faxId } = req.params;
    const pharmacyId = req.user.pharmacyId;

    const result = await db.query(`
      SELECT fl.*,
        u.first_name as sender_first_name, u.last_name as sender_last_name,
        p.first_name as patient_first_name, p.last_name as patient_last_name,
        p.date_of_birth as patient_dob
      FROM fax_log fl
      LEFT JOIN users u ON u.user_id = fl.sent_by
      LEFT JOIN patients p ON p.patient_id = fl.patient_id
      WHERE fl.fax_id = $1 AND fl.pharmacy_id = $2
    `, [faxId, pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fax not found' });
    }

    const fax = result.rows[0];
    res.json({
      ...fax,
      patient_name: formatPatientName(fax.patient_first_name, fax.patient_last_name),
      sender_name: formatPatientName(fax.sender_first_name, fax.sender_last_name),
      prescriber_name_formatted: formatPrescriberName(fax.prescriber_name)
    });
  } catch (error) {
    logger.error('Fax detail error', { error: error.message });
    res.status(500).json({ error: 'Failed to get fax details' });
  }
});

/**
 * GET /api/fax/:faxId/status
 * Refresh fax delivery status from Notifyre
 */
router.get('/:faxId/status', authenticateToken, async (req, res) => {
  try {
    const { faxId } = req.params;
    const updated = await checkFaxStatus(faxId);
    res.json({ status: updated.fax_status, fax: updated });
  } catch (error) {
    logger.error('Fax status check error', { error: error.message });
    res.status(500).json({ error: 'Failed to check fax status' });
  }
});

/**
 * POST /api/fax/refresh-all
 * Refresh status for all pending faxes from Notifyre
 */
router.post('/refresh-all', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;

    // Get all pending faxes for this pharmacy
    const pending = await db.query(`
      SELECT fax_id FROM fax_log
      WHERE pharmacy_id = $1
        AND fax_status IN ('queued', 'sending', 'accepted', 'in_progress')
        AND created_at > NOW() - INTERVAL '7 days'
    `, [pharmacyId]);

    const results = [];
    for (const row of pending.rows) {
      try {
        const updated = await checkFaxStatus(row.fax_id);
        results.push({ fax_id: row.fax_id, status: updated.fax_status });
      } catch (e) {
        results.push({ fax_id: row.fax_id, error: e.message });
      }
    }

    res.json({ refreshed: results.length, results });
  } catch (error) {
    logger.error('Refresh all faxes error', { error: error.message });
    res.status(500).json({ error: 'Failed to refresh fax statuses' });
  }
});

/**
 * POST /api/fax/webhook
 * Notifyre delivery callback - no JWT auth, uses signature verification
 */
router.post('/webhook', async (req, res) => {
  try {
    logger.info('Fax webhook received', {
      body: req.body,
      headers: {
        signature: req.headers['x-notifyre-signature'] || req.headers['x-signature'],
        contentType: req.headers['content-type']
      }
    });

    const signatureHeader = req.headers['x-notifyre-signature'] || req.headers['x-signature'];
    const result = await handleWebhook(req.body, signatureHeader);

    logger.info('Fax webhook processed', { result });
    res.status(200).json({ received: true, ...result });
  } catch (error) {
    logger.error('Fax webhook error', { error: error.message, body: req.body });
    // Return 200 to prevent Notifyre from retrying on validation errors
    res.status(200).json({ received: false, error: error.message });
  }
});

/**
 * GET /api/fax/directory/:prescriberNpi
 * Look up saved fax number for a prescriber
 */
router.get('/directory/:prescriberNpi', authenticateToken, async (req, res) => {
  try {
    const { prescriberNpi } = req.params;
    const pharmacyId = req.user.pharmacyId;

    const result = await db.query(`
      SELECT * FROM prescriber_fax_directory
      WHERE pharmacy_id = $1 AND prescriber_npi = $2
    `, [pharmacyId, prescriberNpi]);

    if (result.rows.length === 0) {
      return res.json({ found: false });
    }

    res.json({ found: true, ...result.rows[0] });
  } catch (error) {
    logger.error('Fax directory lookup error', { error: error.message });
    res.status(500).json({ error: 'Failed to look up prescriber fax number' });
  }
});

/**
 * PUT /api/fax/directory/:prescriberNpi
 * Manually save/update a prescriber fax number
 */
router.put('/directory/:prescriberNpi', authenticateToken, async (req, res) => {
  try {
    const { prescriberNpi } = req.params;
    const { faxNumber, prescriberName } = req.body;
    const pharmacyId = req.user.pharmacyId;

    if (!faxNumber) {
      return res.status(400).json({ error: 'faxNumber is required' });
    }

    const result = await db.query(`
      INSERT INTO prescriber_fax_directory (pharmacy_id, prescriber_npi, prescriber_name, fax_number, created_by)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (pharmacy_id, prescriber_npi)
      DO UPDATE SET fax_number = $4, prescriber_name = COALESCE($3, prescriber_fax_directory.prescriber_name), updated_at = NOW()
      RETURNING *
    `, [pharmacyId, prescriberNpi, prescriberName || null, faxNumber, req.user.userId]);

    res.json({ success: true, ...result.rows[0] });
  } catch (error) {
    logger.error('Fax directory update error', { error: error.message });
    res.status(500).json({ error: 'Failed to save prescriber fax number' });
  }
});

// Helper: Get pharmacy settings
async function getPharmacySettings(pharmacyId) {
  const result = await db.query(
    'SELECT settings FROM pharmacies WHERE pharmacy_id = $1',
    [pharmacyId]
  );
  return result.rows[0]?.settings || {};
}

export default router;
