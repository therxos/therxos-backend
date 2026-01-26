// Microsoft Graph Poller Service for TheRxOS V2
// Fetches nightly dispensing reports from Outcomes (rxinsights_noreply@outcomes.com)
// via Microsoft 365 mailbox, processes encrypted Purview messages, and ingests data

import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { ingestCSV } from './ingestion.js';
import { runOpportunityScan } from './scanner.js';
import { autoCompleteOpportunities } from './gmailPoller.js';

// Microsoft Graph scopes
const SCOPES = ['https://graph.microsoft.com/.default'];
const USER_SCOPES = ['Mail.Read', 'offline_access'];

// MSAL configuration
function getMsalConfig() {
  return {
    auth: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`
    }
  };
}

/**
 * Create MSAL client application
 */
function getMsalClient() {
  const config = getMsalConfig();
  return new ConfidentialClientApplication(config);
}

/**
 * Get Microsoft Graph client using stored tokens
 */
async function getGraphClient() {
  // Get stored tokens from database
  const tokenResult = await db.query(
    "SELECT token_data FROM system_settings WHERE setting_key = 'microsoft_oauth_tokens'"
  );

  if (tokenResult.rows.length === 0) {
    throw new Error('Microsoft OAuth tokens not configured. Please complete OAuth setup at /api/automation/microsoft/auth-url');
  }

  const tokenData = tokenResult.rows[0].token_data;
  const tokens = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

  // Check if token needs refresh
  const msalClient = getMsalClient();

  let accessToken = tokens.accessToken;

  // If token is expired or will expire in 5 minutes, refresh it
  const expiresOn = new Date(tokens.expiresOn);
  const now = new Date();
  const fiveMinutes = 5 * 60 * 1000;

  if (expiresOn.getTime() - now.getTime() < fiveMinutes) {
    logger.info('Microsoft token expired or expiring soon, refreshing...');

    try {
      const refreshResult = await msalClient.acquireTokenByRefreshToken({
        refreshToken: tokens.refreshToken,
        scopes: USER_SCOPES
      });

      // Update stored tokens
      const newTokens = {
        accessToken: refreshResult.accessToken,
        refreshToken: refreshResult.refreshToken || tokens.refreshToken,
        expiresOn: refreshResult.expiresOn.toISOString(),
        account: refreshResult.account
      };

      await db.query(
        "UPDATE system_settings SET token_data = $1, updated_at = NOW() WHERE setting_key = 'microsoft_oauth_tokens'",
        [JSON.stringify(newTokens)]
      );

      accessToken = refreshResult.accessToken;
      logger.info('Microsoft token refreshed successfully');
    } catch (refreshError) {
      logger.error('Failed to refresh Microsoft token', { error: refreshError.message });
      throw new Error('Microsoft token expired. Please re-authenticate at /api/automation/microsoft/auth-url');
    }
  }

  // Create Graph client with the access token
  const client = Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    }
  });

  return client;
}

/**
 * Generate OAuth authorization URL for Microsoft
 */
export function getMicrosoftAuthUrl() {
  const msalClient = getMsalClient();

  const redirectUri = process.env.MICROSOFT_REDIRECT_URI ||
    'https://therxos-backend-production.up.railway.app/api/microsoft/callback';

  const authUrl = msalClient.getAuthCodeUrl({
    scopes: USER_SCOPES,
    redirectUri: redirectUri,
    prompt: 'consent'
  });

  return authUrl;
}

/**
 * Handle OAuth callback and store tokens
 */
export async function handleMicrosoftOAuthCallback(code) {
  const msalClient = getMsalClient();

  const redirectUri = process.env.MICROSOFT_REDIRECT_URI ||
    'https://therxos-backend-production.up.railway.app/api/microsoft/callback';

  const tokenResponse = await msalClient.acquireTokenByCode({
    code: code,
    scopes: USER_SCOPES,
    redirectUri: redirectUri
  });

  // Store tokens in database
  const tokens = {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    expiresOn: tokenResponse.expiresOn.toISOString(),
    account: tokenResponse.account
  };

  await db.query(`
    INSERT INTO system_settings (setting_key, token_data, created_at, updated_at)
    VALUES ('microsoft_oauth_tokens', $1, NOW(), NOW())
    ON CONFLICT (setting_key) DO UPDATE SET token_data = $1, updated_at = NOW()
  `, [JSON.stringify(tokens)]);

  logger.info('Microsoft OAuth tokens stored successfully', {
    account: tokenResponse.account?.username
  });

  return tokens;
}

/**
 * Search for Outcomes dispensing report emails
 */
async function searchForOutcomesEmails(graphClient, options = {}) {
  const { afterDate, maxResults = 25, processedIds = [] } = options;

  // Build search filter for Outcomes emails
  // Looking for emails from rxinsights_noreply@outcomes.com with "Dispensing Report" in subject
  let filter = "from/emailAddress/address eq 'rxinsights_noreply@outcomes.com'";

  if (afterDate) {
    const dateStr = afterDate.toISOString();
    filter += ` and receivedDateTime ge ${dateStr}`;
  }

  try {
    const response = await graphClient
      .api('/me/messages')
      .filter(filter)
      .select('id,subject,from,receivedDateTime,hasAttachments,body')
      .top(maxResults)
      .orderby('receivedDateTime desc')
      .get();

    const messages = response.value || [];

    // Filter out already processed emails and non-dispensing reports
    return messages.filter(m =>
      !processedIds.includes(m.id) &&
      m.subject?.toLowerCase().includes('dispensing report')
    );
  } catch (error) {
    logger.error('Failed to search for Outcomes emails', { error: error.message });
    throw error;
  }
}

/**
 * Extract CSV attachments from an email
 */
async function extractAttachments(graphClient, messageId) {
  try {
    const attachmentsResponse = await graphClient
      .api(`/me/messages/${messageId}/attachments`)
      .get();

    const attachments = [];

    for (const attachment of attachmentsResponse.value || []) {
      // Check if it's a file attachment (not inline or reference)
      if (attachment['@odata.type'] === '#microsoft.graph.fileAttachment') {
        const filename = attachment.name?.toLowerCase() || '';

        // We want CSV files
        if (filename.endsWith('.csv')) {
          // contentBytes is base64 encoded
          const data = Buffer.from(attachment.contentBytes, 'base64');

          attachments.push({
            filename: attachment.name,
            data: data,
            size: attachment.size,
            contentType: attachment.contentType
          });

          logger.info('Found CSV attachment', {
            filename: attachment.name,
            size: attachment.size
          });
        }
      }
    }

    return attachments;
  } catch (error) {
    logger.error('Failed to extract attachments', { messageId, error: error.message });
    throw error;
  }
}

/**
 * Get email metadata
 */
async function getEmailMetadata(graphClient, messageId) {
  try {
    const message = await graphClient
      .api(`/me/messages/${messageId}`)
      .select('id,subject,from,receivedDateTime,body')
      .get();

    return {
      messageId: message.id,
      subject: message.subject,
      from: message.from?.emailAddress?.address,
      date: message.receivedDateTime,
      bodyPreview: message.body?.content?.substring(0, 500)
    };
  } catch (error) {
    logger.error('Failed to get email metadata', { messageId, error: error.message });
    throw error;
  }
}

/**
 * Process a single Outcomes email
 */
async function processOutcomesEmail(graphClient, messageId, pharmacyId) {
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
    // Get email metadata
    const emailData = await getEmailMetadata(graphClient, messageId);

    logger.info('Processing Outcomes email', {
      jobId,
      messageId,
      subject: emailData.subject,
      from: emailData.from,
      date: emailData.date
    });

    // Extract CSV attachments
    const attachments = await extractAttachments(graphClient, messageId);

    if (attachments.length === 0) {
      logger.warn('No CSV attachments found in Outcomes email', { messageId });
      results.errors.push({ general: 'No CSV attachments found' });
      return results;
    }

    for (const attachment of attachments) {
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
          pmsSystem: 'rx30' // Outcomes sends for RX30 clients
        });

        logger.info('Ingestion result', {
          jobId,
          filename: attachment.filename,
          stats: ingestionResult.stats,
          validationErrors: ingestionResult.validationErrors?.slice(0, 5)
        });

        results.attachmentsProcessed++;
        results.recordsIngested += ingestionResult.stats?.inserted || 0;

        // Add debug info
        if (!results.debug) results.debug = [];
        results.debug.push({
          filename: attachment.filename,
          totalRecords: ingestionResult.stats?.totalRecords || 0,
          inserted: ingestionResult.stats?.inserted || 0,
          duplicates: ingestionResult.stats?.duplicates || 0,
          validationErrors: ingestionResult.stats?.errors || 0,
          sampleErrors: ingestionResult.validationErrors?.slice(0, 3).map(e => ({
            row: e.row,
            errors: e.errors?.join(', ') || 'Unknown error'
          }))
        });

        // Get newly ingested prescriptions for auto-complete matching
        const newRxResult = await db.query(`
          SELECT p.*, pat.first_name as patient_first, pat.last_name as patient_last
          FROM prescriptions p
          LEFT JOIN patients pat ON pat.patient_id = p.patient_id
          WHERE p.pharmacy_id = $1
          AND p.source_file = $2
          AND p.created_at >= NOW() - INTERVAL '1 hour'
        `, [pharmacyId, attachment.filename]);

        // Auto-complete matching opportunities
        if (newRxResult.rows.length > 0) {
          const autoCompleteResult = await autoCompleteOpportunities(pharmacyId, newRxResult.rows);
          results.opportunitiesCompleted += autoCompleteResult.updated || 0;
        }

        // Re-scan for new opportunities from newly ingested data
        const scanResult = await runOpportunityScan({
          pharmacyIds: [pharmacyId],
          scanType: 'outcomes_import',
          lookbackHours: 1
        });

        results.newOpportunitiesFound += scanResult.opportunitiesFound || 0;

        logger.info('Outcomes attachment processed', {
          jobId,
          filename: attachment.filename,
          recordsIngested: ingestionResult.stats?.inserted || 0,
          opportunitiesCompleted: results.opportunitiesCompleted,
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
      INSERT INTO processed_emails (email_id, message_id, source, processed_at, job_id, results)
      VALUES ($1, $2, 'microsoft', NOW(), $3, $4)
      ON CONFLICT (message_id) DO UPDATE SET processed_at = NOW(), results = $4
    `, [uuidv4(), messageId, jobId, JSON.stringify(results)]);

    return results;

  } catch (error) {
    logger.error('Failed to process Outcomes email', { jobId, messageId, error: error.message });
    results.errors.push({ general: error.message });
    return results;
  }
}

/**
 * Main polling function - fetches and processes Outcomes dispensing reports
 */
export async function pollForOutcomesReports(options = {}) {
  const { pharmacyId, daysBack = 1 } = options;
  const runId = uuidv4();

  logger.info('Starting Outcomes email poll via Microsoft Graph', { runId, pharmacyId, daysBack });

  try {
    const graphClient = await getGraphClient();

    // Get already processed email IDs
    const intervalDays = parseInt(daysBack) + 1;
    const processedResult = await db.query(
      `SELECT message_id FROM processed_emails WHERE source = 'microsoft' AND processed_at >= NOW() - INTERVAL '${intervalDays} days'`
    );
    const processedIds = processedResult.rows.map(r => r.message_id);

    // Search for new Outcomes emails
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - daysBack);

    const emails = await searchForOutcomesEmails(graphClient, {
      afterDate,
      maxResults: 25,
      processedIds
    });

    logger.info(`Found ${emails.length} unprocessed Outcomes emails`, { runId });

    const allResults = [];

    for (const email of emails) {
      const result = await processOutcomesEmail(graphClient, email.id, pharmacyId);
      allResults.push(result);
    }

    const summary = {
      runId,
      source: 'microsoft',
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

    logger.info('Outcomes email poll completed', summary);

    // Log the run
    await db.query(`
      INSERT INTO poll_runs (run_id, run_type, pharmacy_id, started_at, completed_at, summary)
      VALUES ($1, 'outcomes_poll', $2, NOW(), NOW(), $3)
    `, [runId, pharmacyId, JSON.stringify(summary)]);

    return summary;

  } catch (error) {
    logger.error('Outcomes email poll failed', { runId, error: error.message });
    throw error;
  }
}

export default {
  getMicrosoftAuthUrl,
  handleMicrosoftOAuthCallback,
  pollForOutcomesReports
};
