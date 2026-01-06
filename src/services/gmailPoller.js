// Gmail Polling Service for TheRxOS V2
// Fetches nightly SPP reports from Pioneer via email, processes them,
// auto-completes opportunities, and triggers re-scans for new opportunities

import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { ingestCSV } from './ingestion.js';
import { runOpportunityScan } from './scanner.js';

// Gmail API scopes
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

/**
 * Initialize Gmail API client
 */
async function getGmailClient() {
  // Load credentials from environment or database
  const credentials = {
    client_id: process.env.GMAIL_CLIENT_ID,
    client_secret: process.env.GMAIL_CLIENT_SECRET,
    redirect_uri: process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/oauth/callback'
  };

  const oauth2Client = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    credentials.redirect_uri
  );

  // Get stored tokens from database
  const tokenResult = await db.query(
    "SELECT token_data FROM system_settings WHERE setting_key = 'gmail_oauth_tokens'"
  );

  if (tokenResult.rows.length === 0) {
    throw new Error('Gmail OAuth tokens not configured. Please complete OAuth setup at /api/gmail/auth');
  }

  // token_data is JSONB so it may already be parsed
  const tokenData = tokenResult.rows[0].token_data;
  const tokens = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;
  oauth2Client.setCredentials(tokens);

  // Refresh token if expired
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    const { credentials: newTokens } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(newTokens);

    // Save refreshed tokens
    await db.query(
      "UPDATE system_settings SET token_data = $1, updated_at = NOW() WHERE setting_key = 'gmail_oauth_tokens'",
      [JSON.stringify(newTokens)]
    );
  }

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Search for SPP report emails from RxLocal
 */
async function searchForSPPEmails(gmail, options = {}) {
  const { afterDate, maxResults = 10, processedIds = [] } = options;

  // Build search query for SPP emails from RxLocal
  let query = 'from:Notifications@rxlocal.com subject:"SPP Export" has:attachment';

  if (afterDate) {
    const dateStr = afterDate.toISOString().split('T')[0].replace(/-/g, '/');
    query += ` after:${dateStr}`;
  }

  // Search for matching emails
  const response = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults
  });

  const messages = response.data.messages || [];

  // Filter out already processed emails
  return messages.filter(m => !processedIds.includes(m.id));
}

/**
 * Extract CSV attachments from an email (recursively searches nested parts)
 */
async function extractCSVAttachments(gmail, messageId) {
  const message = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full'
  });

  const attachments = [];

  // Recursively find all parts with CSV attachments
  async function processParts(parts) {
    if (!parts) return;

    for (const part of parts) {
      // Check if this part has nested parts
      if (part.parts) {
        await processParts(part.parts);
      }

      // Check if this part is a CSV attachment
      if (part.filename && part.filename.toLowerCase().endsWith('.csv')) {
        const attachmentId = part.body?.attachmentId;

        if (attachmentId) {
          const attachment = await gmail.users.messages.attachments.get({
            userId: 'me',
            messageId: messageId,
            id: attachmentId
          });

          // Decode base64 attachment
          const data = Buffer.from(attachment.data.data, 'base64');

          attachments.push({
            filename: part.filename,
            data: data,
            size: part.body.size
          });

          logger.info('Found CSV attachment', { filename: part.filename, size: part.body.size });
        }
      }
    }
  }

  // Start with top-level parts or the payload itself
  const topParts = message.data.payload?.parts || [];
  await processParts(topParts);

  // Also check if the payload itself is a CSV (single-part message)
  if (message.data.payload?.filename?.toLowerCase().endsWith('.csv')) {
    const attachmentId = message.data.payload.body?.attachmentId;
    if (attachmentId) {
      const attachment = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: messageId,
        id: attachmentId
      });
      const data = Buffer.from(attachment.data.data, 'base64');
      attachments.push({
        filename: message.data.payload.filename,
        data: data,
        size: message.data.payload.body.size
      });
    }
  }

  logger.info('Extracted attachments from email', {
    messageId,
    attachmentCount: attachments.length,
    filenames: attachments.map(a => a.filename)
  });

  return {
    messageId,
    subject: message.data.payload?.headers?.find(h => h.name === 'Subject')?.value,
    from: message.data.payload?.headers?.find(h => h.name === 'From')?.value,
    date: message.data.payload?.headers?.find(h => h.name === 'Date')?.value,
    attachments
  };
}

/**
 * Match newly dispensed prescriptions to submitted opportunities
 * and mark them as completed
 */
export async function autoCompleteOpportunities(pharmacyId, newPrescriptions) {
  const completedCount = { matched: 0, updated: 0 };

  try {
    // Get all opportunities in "Submitted" or "Pending" status for this pharmacy
    const opportunities = await db.query(`
      SELECT o.*, p.first_name as pat_first, p.last_name as pat_last, p.date_of_birth as pat_dob
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      WHERE o.pharmacy_id = $1
      AND o.status IN ('Submitted', 'Pending', 'submitted', 'pending')
      AND (o.recommended_drug IS NOT NULL OR o.recommended_drug_name IS NOT NULL)
    `, [pharmacyId]);

    if (opportunities.rows.length === 0) {
      logger.info('No submitted opportunities to match', { pharmacyId });
      return completedCount;
    }

    logger.info(`Checking ${opportunities.rows.length} opportunities against ${newPrescriptions.length} new prescriptions`, { pharmacyId });

    // Helper to clean names - remove (BP), extra spaces, non-alpha chars
    const cleanName = (name) => (name || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z]/g, '').trim();

    // Helper to clean drug names - remove NDC in parentheses, normalize
    const cleanDrug = (drug) => (drug || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9\s]/g, '').trim();

    // For each opportunity, check if the recommended drug was dispensed
    for (const opp of opportunities.rows) {
      // Get recommended drug from either column, clean it
      const recommendedDrugRaw = opp.recommended_drug || opp.recommended_drug_name || '';
      const recommendedDrug = cleanDrug(recommendedDrugRaw);
      if (!recommendedDrug) continue;

      // Get first significant word of recommended drug for matching
      const recommendedWords = recommendedDrug.split(/\s+/).filter(w => w.length > 2);
      const recommendedFirstWord = recommendedWords[0] || '';

      // Find matching prescription by patient + drug
      const matchingRx = newPrescriptions.find(rx => {
        // Match patient by name (cleaned of annotations like "(BP)")
        const rxPatFirst = cleanName(rx.patient_first);
        const rxPatLast = cleanName(rx.patient_last);
        const oppPatFirst = cleanName(opp.pat_first);
        const oppPatLast = cleanName(opp.pat_last);

        // At least one name part must match
        const patientMatches = (
          (rxPatFirst && oppPatFirst && (rxPatFirst.includes(oppPatFirst) || oppPatFirst.includes(rxPatFirst))) &&
          (rxPatLast && oppPatLast && (rxPatLast.includes(oppPatLast) || oppPatLast.includes(rxPatLast)))
        );

        if (!patientMatches) return false;

        // Check if dispensed drug matches recommended drug
        const dispensedDrug = cleanDrug(rx.drug_name);
        const dispensedWords = dispensedDrug.split(/\s+/).filter(w => w.length > 2);
        const dispensedFirstWord = dispensedWords[0] || '';

        // Match if first significant word matches, or one contains the other
        const drugMatches = (
          (recommendedFirstWord && dispensedFirstWord &&
           (dispensedFirstWord.includes(recommendedFirstWord) || recommendedFirstWord.includes(dispensedFirstWord))) ||
          dispensedDrug.includes(recommendedFirstWord) ||
          recommendedDrug.includes(dispensedFirstWord)
        );

        return drugMatches;
      });

      if (matchingRx) {
        completedCount.matched++;

        // Update opportunity to Completed
        await db.query(`
          UPDATE opportunities
          SET status = 'Completed',
              actioned_at = NOW(),
              updated_at = NOW(),
              staff_notes = COALESCE(staff_notes, '') || E'\n[Auto-completed] Patient filled ' || $1 || ' on ' || $2
          WHERE opportunity_id = $3
        `, [matchingRx.drug_name, matchingRx.dispensed_date, opp.opportunity_id]);

        completedCount.updated++;

        logger.info('Auto-completed opportunity', {
          opportunityId: opp.opportunity_id,
          patientId: opp.patient_id,
          recommendedDrug: recommendedDrug,
          dispensedDrug: matchingRx.drug_name
        });
      }
    }

    return completedCount;
  } catch (error) {
    logger.error('Auto-complete error', { pharmacyId, error: error.message });
    throw error;
  }
}

/**
 * Process a single SPP email and its attachments
 */
async function processSPPEmail(gmail, messageId, pharmacyId) {
  const jobId = uuidv4();
  const results = {
    jobId,
    messageId,
    attachmentsProcessed: 0,
    recordsIngested: 0,
    opportunitiesCompleted: 0,
    newOpportunitiesFound: 0,
    errors: []
  };

  try {
    // Extract CSV attachments
    const emailData = await extractCSVAttachments(gmail, messageId);

    logger.info('Processing SPP email', {
      jobId,
      messageId,
      subject: emailData.subject,
      attachmentCount: emailData.attachments.length
    });

    for (const attachment of emailData.attachments) {
      try {
        logger.info('Processing attachment', {
          jobId,
          filename: attachment.filename,
          dataSize: attachment.data.length
        });

        // Ingest the CSV data
        const ingestionResult = await ingestCSV(attachment.data, {
          pharmacyId,
          sourceEmail: emailData.from,
          sourceFile: attachment.filename,
          pmsSystem: 'spp'
        });

        logger.info('Ingestion result', {
          jobId,
          filename: attachment.filename,
          stats: ingestionResult.stats,
          validationErrors: ingestionResult.validationErrors?.slice(0, 5)
        });

        results.attachmentsProcessed++;
        results.recordsIngested += ingestionResult.stats.inserted;

        // Add debug info
        if (!results.debug) results.debug = [];
        results.debug.push({
          filename: attachment.filename,
          totalRecords: ingestionResult.stats.totalRecords,
          inserted: ingestionResult.stats.inserted,
          duplicates: ingestionResult.stats.duplicates,
          validationErrors: ingestionResult.stats.errors,
          sampleErrors: ingestionResult.validationErrors?.slice(0, 3).map(e => ({
            row: e.row,
            errors: e.errors.join(', ')
          }))
        });

        // Get the newly ingested prescriptions for auto-complete matching
        const newRxResult = await db.query(`
          SELECT p.*, pat.first_name as patient_first, pat.last_name as patient_last
          FROM prescriptions p
          LEFT JOIN patients pat ON pat.patient_id = p.patient_id
          WHERE p.pharmacy_id = $1
          AND p.source_file = $2
          AND p.created_at >= NOW() - INTERVAL '1 hour'
        `, [pharmacyId, attachment.filename]);

        // Auto-complete matching opportunities
        const autoCompleteResult = await autoCompleteOpportunities(pharmacyId, newRxResult.rows);
        results.opportunitiesCompleted += autoCompleteResult.updated;

        // Re-scan for new opportunities from newly ingested data
        const scanResult = await runOpportunityScan({
          pharmacyIds: [pharmacyId],
          scanType: 'spp_import',
          lookbackHours: 1 // Only scan recently ingested data
        });

        results.newOpportunitiesFound += scanResult.opportunitiesFound;

        logger.info('SPP attachment processed', {
          jobId,
          filename: attachment.filename,
          recordsIngested: ingestionResult.stats.inserted,
          opportunitiesCompleted: autoCompleteResult.updated,
          newOpportunities: scanResult.opportunitiesFound
        });

      } catch (attachmentError) {
        results.errors.push({
          filename: attachment.filename,
          error: attachmentError.message
        });
        logger.error('Failed to process attachment', {
          jobId,
          filename: attachment.filename,
          error: attachmentError.message
        });
      }
    }

    // Mark email as processed
    await db.query(`
      INSERT INTO processed_emails (email_id, message_id, processed_at, job_id, results)
      VALUES ($1, $2, NOW(), $3, $4)
      ON CONFLICT (message_id) DO UPDATE SET processed_at = NOW(), results = $4
    `, [uuidv4(), messageId, jobId, JSON.stringify(results)]);

    return results;

  } catch (error) {
    logger.error('Failed to process SPP email', { jobId, messageId, error: error.message });
    results.errors.push({ general: error.message });
    return results;
  }
}

/**
 * Main polling function - runs nightly to fetch and process SPP reports
 */
export async function pollForSPPReports(options = {}) {
  const { pharmacyId, daysBack = 1 } = options;
  const runId = uuidv4();

  logger.info('Starting SPP email poll', { runId, pharmacyId, daysBack });

  try {
    const gmail = await getGmailClient();

    // Get already processed email IDs
    const intervalDays = parseInt(daysBack) + 1;
    const processedResult = await db.query(
      `SELECT message_id FROM processed_emails WHERE processed_at >= NOW() - INTERVAL '${intervalDays} days'`
    );
    const processedIds = processedResult.rows.map(r => r.message_id);

    // Search for new SPP emails
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - daysBack);

    const emails = await searchForSPPEmails(gmail, {
      afterDate,
      maxResults: 20,
      processedIds
    });

    logger.info(`Found ${emails.length} unprocessed SPP emails`, { runId });

    const allResults = [];

    for (const email of emails) {
      const result = await processSPPEmail(gmail, email.id, pharmacyId);
      allResults.push(result);
    }

    const summary = {
      runId,
      emailsProcessed: allResults.length,
      attachmentsProcessed: allResults.reduce((sum, r) => sum + r.attachmentsProcessed, 0),
      totalRecordsIngested: allResults.reduce((sum, r) => sum + r.recordsIngested, 0),
      totalOpportunitiesCompleted: allResults.reduce((sum, r) => sum + r.opportunitiesCompleted, 0),
      totalNewOpportunities: allResults.reduce((sum, r) => sum + r.newOpportunitiesFound, 0),
      errors: allResults.flatMap(r => r.errors),
      debug: allResults.flatMap(r => r.debug || []),
      details: allResults.map(r => ({
        messageId: r.messageId,
        attachments: r.attachmentsProcessed,
        records: r.recordsIngested,
        errors: r.errors
      }))
    };

    logger.info('SPP email poll completed', summary);

    // Log the run
    await db.query(`
      INSERT INTO poll_runs (run_id, run_type, pharmacy_id, started_at, completed_at, summary)
      VALUES ($1, 'spp_poll', $2, NOW(), NOW(), $3)
    `, [runId, pharmacyId, JSON.stringify(summary)]);

    return summary;

  } catch (error) {
    logger.error('SPP email poll failed', { runId, error: error.message });
    throw error;
  }
}

/**
 * Generate OAuth URL for Gmail authorization
 */
export function getGmailAuthUrl() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/oauth/callback'
  );

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
}

/**
 * Handle OAuth callback and store tokens
 */
export async function handleGmailOAuthCallback(code) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI || 'http://localhost:3001/api/oauth/callback'
  );

  const { tokens } = await oauth2Client.getToken(code);

  // Store tokens in database
  await db.query(`
    INSERT INTO system_settings (setting_key, token_data, created_at, updated_at)
    VALUES ('gmail_oauth_tokens', $1, NOW(), NOW())
    ON CONFLICT (setting_key) DO UPDATE SET token_data = $1, updated_at = NOW()
  `, [JSON.stringify(tokens)]);

  return tokens;
}

export default {
  pollForSPPReports,
  autoCompleteOpportunities,
  getGmailAuthUrl,
  handleGmailOAuthCallback
};
