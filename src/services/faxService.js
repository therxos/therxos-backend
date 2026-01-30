// Fax Service - Notifyre API integration for TheRxOS
// Handles sending faxes, tracking delivery status, and webhook processing

import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { checkFaxLimits, canFaxPrescriber, DEFAULT_PHARMACY_SETTINGS } from '../utils/permissions.js';

// Cached async getter for Notifyre SDK (lazy-loaded on first use)
let _sdkPromise = null;
async function getFaxClient() {
  if (!_sdkPromise) {
    _sdkPromise = (async () => {
      if (!process.env.NOTIFYRE_API_KEY) {
        throw new Error('NOTIFYRE_API_KEY is not configured');
      }
      const sdk = await import('notifyre-nodejs-sdk');
      const NotifyreAPI = sdk.NotifyreAPI || sdk.default?.NotifyreAPI;
      const api = new NotifyreAPI(process.env.NOTIFYRE_API_KEY);
      return api.getFaxService();
    })();
  }
  return _sdkPromise;
}

/**
 * Run all pre-send safety checks without sending
 * Returns { canSend, warnings[], savedFaxNumber, dailyCount, dailyLimit, cooldownInfo }
 */
export async function preflightCheck({ pharmacyId, opportunityId, prescriberNpi }) {
  const warnings = [];
  let canSend = true;

  // 1. Check pharmacy has fax enabled
  const pharmacyResult = await db.query(
    'SELECT settings, fax FROM pharmacies WHERE pharmacy_id = $1',
    [pharmacyId]
  );
  const pharmacy = pharmacyResult.rows[0];
  if (!pharmacy) {
    return { canSend: false, warnings: ['Pharmacy not found'] };
  }

  const settings = pharmacy.settings || {};
  if (!settings.faxEnabled) {
    return { canSend: false, warnings: ['Fax sending is not enabled for this pharmacy. Contact your administrator.'] };
  }

  // 2. Check opportunity exists, is Not Submitted, and has no data quality issues
  const oppResult = await db.query(`
    SELECT o.*, pr.prescriber_name, pr.prescriber_npi
    FROM opportunities o
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    WHERE o.opportunity_id = $1 AND o.pharmacy_id = $2
  `, [opportunityId, pharmacyId]);

  if (oppResult.rows.length === 0) {
    return { canSend: false, warnings: ['Opportunity not found'] };
  }

  const opp = oppResult.rows[0];
  if (opp.status !== 'Not Submitted') {
    canSend = false;
    warnings.push(`Opportunity has already been actioned (status: ${opp.status})`);
  }

  // Check data quality
  const dqResult = await db.query(`
    SELECT COUNT(*) as count FROM data_quality_issues
    WHERE opportunity_id = $1 AND status = 'pending'
  `, [opportunityId]);

  if (parseInt(dqResult.rows[0].count) > 0) {
    canSend = false;
    warnings.push('Opportunity has unresolved data quality issues');
  }

  // Check prescriber NPI exists
  const effectiveNpi = prescriberNpi || opp.prescriber_npi;
  if (!effectiveNpi) {
    canSend = false;
    warnings.push('No prescriber NPI available for this opportunity');
  }

  // 3. Check daily fax limit
  const todayFaxes = await db.query(`
    SELECT fax_id, sent_at as sent_date FROM fax_log
    WHERE pharmacy_id = $1 AND DATE(sent_at) = CURRENT_DATE AND fax_status != 'cancelled'
  `, [pharmacyId]);

  const limitCheck = checkFaxLimits(settings, todayFaxes.rows);
  const faxLimits = settings.fax_limits || DEFAULT_PHARMACY_SETTINGS.fax_limits;

  if (!limitCheck.allowed) {
    canSend = false;
    warnings.push(limitCheck.reason);
  }

  // 4. Check prescriber cooldown
  let cooldownInfo = { allowed: true };
  if (effectiveNpi) {
    const cooldownDays = faxLimits.same_prescriber_cooldown_days || 7;
    const recentFaxes = await db.query(`
      SELECT fax_id, prescriber_npi as prescriber_id, sent_at as sent_date
      FROM fax_log
      WHERE pharmacy_id = $1 AND prescriber_npi = $2
        AND sent_at >= NOW() - INTERVAL '${cooldownDays} days'
        AND fax_status != 'cancelled'
      ORDER BY sent_at DESC
    `, [pharmacyId, effectiveNpi]);

    cooldownInfo = canFaxPrescriber(settings, effectiveNpi, recentFaxes.rows);
    if (!cooldownInfo.allowed) {
      canSend = false;
      warnings.push(cooldownInfo.reason);
    }
  }

  // 5. Check excluded prescribers
  if (effectiveNpi) {
    const excludedResult = await db.query(`
      SELECT 1 FROM excluded_prescribers
      WHERE pharmacy_id = $1 AND prescriber_npi = $2
    `, [pharmacyId, effectiveNpi]);

    if (excludedResult.rows.length > 0) {
      canSend = false;
      warnings.push('This prescriber is on the excluded list');
    }
  }

  // 6. Look up saved fax number
  let savedFaxNumber = null;
  if (effectiveNpi) {
    const dirResult = await db.query(`
      SELECT fax_number FROM prescriber_fax_directory
      WHERE pharmacy_id = $1 AND prescriber_npi = $2
    `, [pharmacyId, effectiveNpi]);
    savedFaxNumber = dirResult.rows[0]?.fax_number || null;
  }

  return {
    canSend,
    warnings,
    savedFaxNumber,
    dailyCount: todayFaxes.rows.length,
    dailyLimit: faxLimits.max_per_day || 10,
    cooldownInfo,
    opportunity: {
      opportunity_id: opp.opportunity_id,
      current_drug_name: opp.current_drug_name,
      recommended_drug_name: opp.recommended_drug_name,
      opportunity_type: opp.opportunity_type,
      prescriber_name: opp.prescriber_name,
      prescriber_npi: effectiveNpi
    }
  };
}

/**
 * Send a fax via Notifyre
 * @param {Object} params
 * @param {string} params.pharmacyId
 * @param {string} params.opportunityId
 * @param {string} params.prescriberFaxNumber - Fax number to send to
 * @param {string} params.prescriberNpi
 * @param {string} params.prescriberName
 * @param {boolean} params.npiConfirmed - User confirmed NPI matches hardcopy
 * @param {string} params.sentBy - User ID who initiated the send
 * @param {Buffer} params.pdfBuffer - Generated PDF document
 * @returns {Object} { faxId, faxLogId, status }
 */
export async function sendFax({
  pharmacyId, opportunityId, prescriberFaxNumber, prescriberNpi,
  prescriberName, npiConfirmed, sentBy, pdfBuffer
}) {
  // Load opportunity data for the fax log
  const oppResult = await db.query(`
    SELECT o.*, p.first_name, p.last_name, p.patient_id
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.opportunity_id = $1
  `, [opportunityId]);

  const opp = oppResult.rows[0];
  if (!opp) throw new Error('Opportunity not found');

  const faxLogId = uuidv4();

  // Send via Notifyre SDK
  let notifyreResult;
  try {
    const client = await getFaxClient();

    // The SDK uploads documents first, then sends
    notifyreResult = await client.submitFax({
      documents: [{
        fileName: `therapeutic-recommendation-${opportunityId.slice(0, 8)}.pdf`,
        contentType: 'application/pdf',
        content: pdfBuffer.toString('base64')
      }],
      recipients: [{
        type: 'fax_number',
        value: prescriberFaxNumber
      }],
      subject: `Therapeutic Recommendation - ${prescriberName || 'Prescriber'}`,
      header: 'TheRxOS',
      isHighQuality: false,
      clientReference: faxLogId
    });
  } catch (sdkError) {
    // Log the failed attempt
    await db.insert('fax_log', {
      fax_id: faxLogId,
      pharmacy_id: pharmacyId,
      opportunity_id: opportunityId,
      patient_id: opp.patient_id,
      prescriber_name: prescriberName,
      prescriber_npi: prescriberNpi,
      prescriber_fax_number: prescriberFaxNumber,
      fax_status: 'failed',
      trigger_type: opp.opportunity_type,
      current_drug: opp.current_drug_name,
      recommended_drug: opp.recommended_drug_name,
      sent_by: sentBy,
      npi_confirmed: npiConfirmed || false,
      failed_reason: sdkError.message
    });

    throw new Error(`Fax send failed: ${sdkError.message}`);
  }

  // Extract the Notifyre fax ID from response
  const notifyreFaxId = notifyreResult?.payload?.id
    || notifyreResult?.payload?.faxId
    || notifyreResult?.id
    || null;

  // Insert fax log record
  await db.insert('fax_log', {
    fax_id: faxLogId,
    pharmacy_id: pharmacyId,
    opportunity_id: opportunityId,
    patient_id: opp.patient_id,
    prescriber_name: prescriberName,
    prescriber_npi: prescriberNpi,
    prescriber_fax_number: prescriberFaxNumber,
    notifyre_fax_id: notifyreFaxId ? String(notifyreFaxId) : null,
    fax_status: 'queued',
    trigger_type: opp.opportunity_type,
    current_drug: opp.current_drug_name,
    recommended_drug: opp.recommended_drug_name,
    sent_by: sentBy,
    npi_confirmed: npiConfirmed || false
  });

  // Update opportunity status to Submitted
  await db.query(`
    UPDATE opportunities SET
      status = 'Submitted',
      actioned_by = $2,
      actioned_at = NOW(),
      reviewed_by = $2,
      reviewed_at = NOW(),
      updated_at = NOW()
    WHERE opportunity_id = $1
  `, [opportunityId, sentBy]);

  // Log the action
  try {
    await db.insert('opportunity_actions', {
      action_id: uuidv4(),
      opportunity_id: opportunityId,
      action_type: 'Submitted',
      action_details: JSON.stringify({
        method: 'fax',
        fax_id: faxLogId,
        prescriber_fax: prescriberFaxNumber,
        prescriber_npi: prescriberNpi
      }),
      performed_by: sentBy,
      outcome: 'success'
    });
  } catch (logErr) {
    logger.warn('Failed to log fax action', { error: logErr.message });
  }

  // Save/update prescriber fax directory
  if (prescriberNpi && prescriberFaxNumber) {
    try {
      await db.query(`
        INSERT INTO prescriber_fax_directory (pharmacy_id, prescriber_npi, prescriber_name, fax_number, created_by)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (pharmacy_id, prescriber_npi)
        DO UPDATE SET fax_number = $4, prescriber_name = $3, updated_at = NOW()
      `, [pharmacyId, prescriberNpi, prescriberName, prescriberFaxNumber, sentBy]);
    } catch (dirErr) {
      logger.warn('Failed to save prescriber fax number', { error: dirErr.message });
    }
  }

  logger.info('Fax sent successfully', {
    faxLogId,
    notifyreFaxId,
    opportunityId,
    pharmacyId,
    prescriberNpi,
    sentBy
  });

  return {
    faxId: notifyreFaxId,
    faxLogId,
    status: 'queued'
  };
}

/**
 * Check/refresh fax delivery status from Notifyre
 */
export async function checkFaxStatus(faxLogId) {
  const result = await db.query(
    'SELECT * FROM fax_log WHERE fax_id = $1',
    [faxLogId]
  );

  const faxLog = result.rows[0];
  if (!faxLog) throw new Error('Fax log entry not found');
  if (!faxLog.notifyre_fax_id) return faxLog; // Can't check without Notifyre ID

  try {
    const client = await getFaxClient();
    const statusResult = await client.listSentFaxes({
      fromDate: new Date(faxLog.sent_at).toISOString(),
      toDate: new Date().toISOString(),
      limit: 10
    });

    // Find our fax in the results
    const faxes = statusResult?.payload?.faxes || statusResult?.payload || [];
    const match = Array.isArray(faxes)
      ? faxes.find(f => String(f.id) === String(faxLog.notifyre_fax_id))
      : null;

    if (match) {
      const newStatus = match.status || faxLog.fax_status;
      await db.query(`
        UPDATE fax_log SET
          fax_status = $2,
          page_count = COALESCE($3, page_count),
          cost_cents = COALESCE($4, cost_cents),
          delivered_at = CASE WHEN $2 = 'successful' THEN NOW() ELSE delivered_at END,
          last_status_check = NOW(),
          updated_at = NOW()
        WHERE fax_id = $1
      `, [faxLogId, newStatus, match.pages || null, match.cost ? Math.round(match.cost * 100) : null]);

      return { ...faxLog, fax_status: newStatus };
    }
  } catch (err) {
    logger.warn('Failed to check fax status from Notifyre', { faxLogId, error: err.message });
  }

  // Update last check time even if we couldn't get status
  await db.query(
    'UPDATE fax_log SET last_status_check = NOW() WHERE fax_id = $1',
    [faxLogId]
  );

  return faxLog;
}

/**
 * Process Notifyre webhook delivery notification
 */
export async function handleWebhook(payload, signatureHeader) {
  // Verify webhook signature if secret is configured
  if (process.env.NOTIFYRE_WEBHOOK_SECRET && signatureHeader) {
    try {
      const { verifySignature } = await import('notifyre-nodejs-sdk');
      verifySignature(signatureHeader, payload, process.env.NOTIFYRE_WEBHOOK_SECRET);
    } catch (sigErr) {
      logger.warn('Webhook signature verification failed', { error: sigErr.message });
      throw new Error('Invalid webhook signature');
    }
  }

  // Map Notifyre status to our status values
  const statusMap = {
    'accepted': 'accepted',
    'queued': 'queued',
    'in_progress': 'in_progress',
    'successful': 'successful',
    'failed': 'failed',
    'no_answer': 'no_answer',
    'busy': 'busy',
    'cancelled': 'cancelled'
  };

  const faxId = payload?.id || payload?.faxId || payload?.data?.id;
  const status = statusMap[payload?.status || payload?.data?.status] || payload?.status;

  if (!faxId) {
    logger.warn('Webhook received without fax ID', { payload });
    return { processed: false, reason: 'No fax ID in payload' };
  }

  // Find the fax log entry by Notifyre ID
  const result = await db.query(
    'SELECT fax_id FROM fax_log WHERE notifyre_fax_id = $1',
    [String(faxId)]
  );

  if (result.rows.length === 0) {
    logger.warn('Webhook for unknown fax ID', { notifyreFaxId: faxId });
    return { processed: false, reason: 'Unknown fax ID' };
  }

  const faxLogId = result.rows[0].fax_id;

  await db.query(`
    UPDATE fax_log SET
      fax_status = COALESCE($2, fax_status),
      delivered_at = CASE WHEN $2 = 'successful' THEN NOW() ELSE delivered_at END,
      failed_reason = $3,
      page_count = COALESCE($4, page_count),
      cost_cents = COALESCE($5, cost_cents),
      notifyre_webhook_data = $6,
      last_status_check = NOW(),
      updated_at = NOW()
    WHERE fax_id = $1
  `, [
    faxLogId,
    status,
    payload?.failureReason || payload?.data?.failureReason || null,
    payload?.pages || payload?.data?.pages || null,
    payload?.cost ? Math.round(payload.cost * 100) : null,
    JSON.stringify(payload)
  ]);

  logger.info('Fax webhook processed', { faxLogId, notifyreFaxId: faxId, status });

  return { processed: true, faxLogId, status };
}

/**
 * Get fax statistics for a pharmacy
 */
export async function getFaxStats(pharmacyId, days = 30) {
  const interval = `${parseInt(days)} days`;

  const [summary, byType, byUser, daily] = await Promise.all([
    db.query(`
      SELECT
        COUNT(*) as total_sent,
        COUNT(*) FILTER (WHERE fax_status = 'successful') as delivered,
        COUNT(*) FILTER (WHERE fax_status = 'failed') as failed,
        COUNT(*) FILTER (WHERE fax_status IN ('queued', 'sending', 'accepted', 'in_progress')) as pending,
        COALESCE(SUM(cost_cents), 0) as total_cost_cents,
        COALESCE(SUM(page_count), 0) as total_pages,
        CASE WHEN COUNT(*) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE fax_status = 'successful') / COUNT(*), 1)
          ELSE 0 END as delivery_rate
      FROM fax_log
      WHERE pharmacy_id = $1 AND sent_at >= NOW() - INTERVAL '${interval}'
    `, [pharmacyId]),

    db.query(`
      SELECT trigger_type, COUNT(*) as count,
        COUNT(*) FILTER (WHERE fax_status = 'successful') as delivered
      FROM fax_log
      WHERE pharmacy_id = $1 AND sent_at >= NOW() - INTERVAL '${interval}'
      GROUP BY trigger_type ORDER BY count DESC
    `, [pharmacyId]),

    db.query(`
      SELECT u.first_name, u.last_name, u.user_id,
        COUNT(*) as faxes_sent,
        COUNT(*) FILTER (WHERE fl.fax_status = 'successful') as delivered
      FROM fax_log fl
      JOIN users u ON u.user_id = fl.sent_by
      WHERE fl.pharmacy_id = $1 AND fl.sent_at >= NOW() - INTERVAL '${interval}'
      GROUP BY u.user_id, u.first_name, u.last_name
      ORDER BY faxes_sent DESC
    `, [pharmacyId]),

    db.query(`
      SELECT DATE(sent_at) as date,
        COUNT(*) as sent,
        COUNT(*) FILTER (WHERE fax_status = 'successful') as delivered
      FROM fax_log
      WHERE pharmacy_id = $1 AND sent_at >= NOW() - INTERVAL '${interval}'
      GROUP BY DATE(sent_at) ORDER BY date ASC
    `, [pharmacyId])
  ]);

  return {
    summary: summary.rows[0],
    byType: byType.rows,
    byUser: byUser.rows,
    daily: daily.rows
  };
}

/**
 * Get fax log entries for a pharmacy
 */
export async function getFaxLog(pharmacyId, { status, startDate, endDate, prescriberNpi, limit = 50, offset = 0 } = {}) {
  let query = `
    SELECT fl.*,
      u.first_name as sender_first_name, u.last_name as sender_last_name,
      p.first_name as patient_first_name, p.last_name as patient_last_name
    FROM fax_log fl
    LEFT JOIN users u ON u.user_id = fl.sent_by
    LEFT JOIN patients p ON p.patient_id = fl.patient_id
    WHERE fl.pharmacy_id = $1
  `;
  const params = [pharmacyId];
  let paramIndex = 2;

  if (status) {
    query += ` AND fl.fax_status = $${paramIndex++}`;
    params.push(status);
  }
  if (startDate) {
    query += ` AND fl.sent_at >= $${paramIndex++}`;
    params.push(startDate);
  }
  if (endDate) {
    query += ` AND fl.sent_at <= $${paramIndex++}`;
    params.push(endDate);
  }
  if (prescriberNpi) {
    query += ` AND fl.prescriber_npi = $${paramIndex++}`;
    params.push(prescriberNpi);
  }

  query += ` ORDER BY fl.sent_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  params.push(parseInt(limit), parseInt(offset));

  const result = await db.query(query, params);

  // Get total count
  let countQuery = `SELECT COUNT(*) as total FROM fax_log WHERE pharmacy_id = $1`;
  const countParams = [pharmacyId];
  let countIndex = 2;
  if (status) {
    countQuery += ` AND fax_status = $${countIndex++}`;
    countParams.push(status);
  }

  const countResult = await db.query(countQuery, countParams);

  return {
    faxes: result.rows,
    total: parseInt(countResult.rows[0].total),
    limit: parseInt(limit),
    offset: parseInt(offset)
  };
}

export default {
  preflightCheck,
  sendFax,
  checkFaxStatus,
  handleWebhook,
  getFaxStats,
  getFaxLog
};
