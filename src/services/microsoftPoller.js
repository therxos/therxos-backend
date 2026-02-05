// Microsoft Graph Poller Service for TheRxOS V2
// Fetches nightly dispensing reports from Outcomes (rxinsights_noreply@outcomes.com)
// via Microsoft 365 mailbox, processes encrypted Purview messages, and ingests data

import { ConfidentialClientApplication } from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';
import { v4 as uuidv4 } from 'uuid';
import AdmZip from 'adm-zip';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { ingestCSV } from './ingestion.js';
import { runOpportunityScan } from './scanner.js';
import { autoCompleteOpportunities } from './gmailPoller.js';

// Microsoft Graph scopes
const SCOPES = ['https://graph.microsoft.com/.default'];
const USER_SCOPES = ['Mail.Read', 'Files.Read', 'Files.ReadWrite', 'offline_access'];

// Database-backed token cache for MSAL
class DatabaseTokenCache {
  constructor() {
    this.cache = null;
  }

  async beforeCacheAccess(context) {
    try {
      const result = await db.query(
        "SELECT setting_value FROM system_settings WHERE setting_key = 'msal_token_cache'"
      );
      if (result.rows.length > 0 && result.rows[0].setting_value) {
        context.tokenCache.deserialize(result.rows[0].setting_value);
      }
    } catch (e) {
      logger.error('Failed to load MSAL cache from database', { error: e.message });
    }
  }

  async afterCacheAccess(context) {
    if (context.cacheHasChanged) {
      try {
        const serialized = context.tokenCache.serialize();
        await db.query(`
          INSERT INTO system_settings (setting_key, setting_value, created_at, updated_at)
          VALUES ('msal_token_cache', $1, NOW(), NOW())
          ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()
        `, [serialized]);
      } catch (e) {
        logger.error('Failed to save MSAL cache to database', { error: e.message });
      }
    }
  }
}

// Singleton cache plugin
let cachePlugin = null;
function getCachePlugin() {
  if (!cachePlugin) {
    const cache = new DatabaseTokenCache();
    cachePlugin = {
      beforeCacheAccess: (context) => cache.beforeCacheAccess(context),
      afterCacheAccess: (context) => cache.afterCacheAccess(context)
    };
  }
  return cachePlugin;
}

// MSAL configuration with cache
function getMsalConfig() {
  return {
    auth: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`
    },
    cache: {
      cachePlugin: getCachePlugin()
    }
  };
}

/**
 * Create MSAL client application with persistent cache
 */
function getMsalClient() {
  const config = getMsalConfig();
  return new ConfidentialClientApplication(config);
}

/**
 * Get Microsoft Graph client using MSAL with auto-refresh
 */
async function getGraphClient() {
  const msalClient = getMsalClient();

  // Get account from stored tokens
  const tokenResult = await db.query(
    "SELECT token_data FROM system_settings WHERE setting_key = 'microsoft_oauth_tokens'"
  );

  if (tokenResult.rows.length === 0) {
    throw new Error('Microsoft OAuth tokens not configured. Please complete OAuth setup at /api/automation/microsoft/auth-url');
  }

  const tokenData = tokenResult.rows[0].token_data;
  const tokens = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

  let accessToken;

  try {
    // Try to get token silently (will auto-refresh if needed using MSAL cache)
    const accounts = await msalClient.getTokenCache().getAllAccounts();

    if (accounts.length > 0) {
      // Use cached account for silent token acquisition
      const silentResult = await msalClient.acquireTokenSilent({
        account: accounts[0],
        scopes: USER_SCOPES
      });
      accessToken = silentResult.accessToken;
      logger.info('Got token silently from MSAL cache');

      // Update stored tokens with fresh ones
      const newTokens = {
        accessToken: silentResult.accessToken,
        refreshToken: tokens.refreshToken, // Keep existing refresh token
        expiresOn: silentResult.expiresOn.toISOString(),
        account: silentResult.account
      };
      await db.query(
        "UPDATE system_settings SET token_data = $1, updated_at = NOW() WHERE setting_key = 'microsoft_oauth_tokens'",
        [JSON.stringify(newTokens)]
      );
    } else if (tokens.refreshToken) {
      // Fallback: use refresh token directly if no cached account
      logger.info('No cached account, using refresh token...');
      const refreshResult = await msalClient.acquireTokenByRefreshToken({
        refreshToken: tokens.refreshToken,
        scopes: USER_SCOPES
      });
      accessToken = refreshResult.accessToken;

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
      logger.info('Token refreshed via refresh token');
    } else {
      // No cache and no refresh token - use stored access token if not expired
      const expiresOn = new Date(tokens.expiresOn);
      if (expiresOn > new Date()) {
        accessToken = tokens.accessToken;
        logger.info('Using stored access token (not expired)');
      } else {
        throw new Error('Token expired and no refresh token available');
      }
    }
  } catch (silentError) {
    logger.error('Silent token acquisition failed', { error: silentError.message });
    throw new Error('Microsoft token expired. Please re-authenticate at /api/automation/microsoft/auth-url');
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
export async function getMicrosoftAuthUrl() {
  const msalClient = getMsalClient();

  const redirectUri = process.env.MICROSOFT_REDIRECT_URI ||
    'https://therxos-backend-production.up.railway.app/api/automation/microsoft/callback';

  // MSAL getAuthCodeUrl returns a Promise - must await it
  const authUrl = await msalClient.getAuthCodeUrl({
    scopes: USER_SCOPES,
    redirectUri: redirectUri,
    prompt: 'consent',
    responseMode: 'query'
  });

  logger.info('Generated Microsoft auth URL', { redirectUri, scopes: USER_SCOPES });

  return authUrl;
}

/**
 * Handle OAuth callback and store tokens
 */
export async function handleMicrosoftOAuthCallback(code) {
  const msalClient = getMsalClient();

  const redirectUri = process.env.MICROSOFT_REDIRECT_URI ||
    'https://therxos-backend-production.up.railway.app/api/automation/microsoft/callback';

  const tokenResponse = await msalClient.acquireTokenByCode({
    code: code,
    scopes: USER_SCOPES,
    redirectUri: redirectUri
  });

  // Log full response for debugging
  logger.info('Microsoft OAuth token response', {
    hasAccessToken: !!tokenResponse.accessToken,
    hasRefreshToken: !!tokenResponse.refreshToken,
    hasIdToken: !!tokenResponse.idToken,
    expiresOn: tokenResponse.expiresOn,
    account: tokenResponse.account?.username,
    responseKeys: Object.keys(tokenResponse)
  });

  // CRITICAL: Ensure refresh token is captured
  if (!tokenResponse.refreshToken) {
    logger.warn('No refresh token in OAuth response! Token will expire and cannot auto-refresh.');
  }

  // Store tokens in database
  const tokens = {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken || null,
    idToken: tokenResponse.idToken || null,
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
  const { afterDate, maxResults = 50, processedIds = [] } = options;

  try {
    // Simple approach: get recent messages and filter in code
    // Graph API has complex filter/search limitations, so we fetch more and filter locally
    const response = await graphClient
      .api('/me/messages')
      .select('id,subject,from,receivedDateTime,hasAttachments')
      .top(maxResults)
      .orderby('receivedDateTime desc')
      .get();

    let messages = response.value || [];

    logger.info('Fetched messages from Microsoft', { count: messages.length });

    // Filter to Outcomes emails with "Dispensing Report"
    messages = messages.filter(m => {
      const fromAddress = m.from?.emailAddress?.address?.toLowerCase() || '';
      const subject = m.subject?.toLowerCase() || '';
      return fromAddress.includes('outcomes.com') && subject.includes('dispensing report');
    });

    logger.info('Filtered to Outcomes dispensing reports', { count: messages.length });

    // Filter by date
    if (afterDate) {
      messages = messages.filter(m => new Date(m.receivedDateTime) >= afterDate);
    }

    // Filter out already processed emails
    return messages.filter(m => !processedIds.includes(m.id));
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
    const allAttachmentInfo = [];

    for (const attachment of attachmentsResponse.value || []) {
      // Log all attachments for debugging
      allAttachmentInfo.push({
        name: attachment.name,
        type: attachment['@odata.type'],
        contentType: attachment.contentType,
        size: attachment.size
      });

      // Check if it's a file attachment (not inline or reference)
      if (attachment['@odata.type'] === '#microsoft.graph.fileAttachment') {
        const filename = attachment.name?.toLowerCase() || '';

        // We want CSV files (or xlsx which we might need to convert)
        if (filename.endsWith('.csv') || filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
          // contentBytes is base64 encoded
          const data = Buffer.from(attachment.contentBytes, 'base64');

          attachments.push({
            filename: attachment.name,
            data: data,
            size: attachment.size,
            contentType: attachment.contentType
          });

          logger.info('Found data attachment', {
            filename: attachment.name,
            size: attachment.size,
            contentType: attachment.contentType
          });
        }
      }
    }

    // Log all attachments found
    logger.info('All attachments on email', { messageId, attachments: allAttachmentInfo });

    return { attachments, allAttachmentInfo };
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
    const { attachments, allAttachmentInfo } = await extractAttachments(graphClient, messageId);

    // Include all attachment info in results for debugging
    results.allAttachmentsFound = allAttachmentInfo;

    if (attachments.length === 0) {
      logger.warn('No CSV attachments found in Outcomes email', { messageId, allAttachmentInfo });
      results.errors.push({ general: 'No CSV attachments found', attachmentsOnEmail: allAttachmentInfo });
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

/**
 * Poll OneDrive folder for new Outcomes report files
 * This is used when Power Automate saves email attachments to OneDrive
 */
export async function pollOneDriveForReports(options = {}) {
  const { pharmacyId, folderPath = '/OutcomesReports', daysBack = 7 } = options;
  const runId = uuidv4();

  logger.info('Starting OneDrive poll for Outcomes reports', { runId, pharmacyId, folderPath });

  const results = {
    runId,
    source: 'onedrive',
    filesProcessed: 0,
    recordsIngested: 0,
    opportunitiesCompleted: 0,
    newOpportunitiesFound: 0,
    errors: []
  };

  try {
    const graphClient = await getGraphClient();

    // Get files from the OneDrive folder
    // The folder path should be something like /OutcomesReports
    const encodedPath = encodeURIComponent(folderPath.replace(/^\//, ''));

    let files;
    try {
      const response = await graphClient
        .api(`/me/drive/root:/${encodedPath}:/children`)
        .select('id,name,createdDateTime,size,file')
        .orderby('createdDateTime desc')
        .top(50)
        .get();

      files = response.value || [];
    } catch (folderError) {
      // Folder might not exist yet
      if (folderError.statusCode === 404) {
        logger.info('OneDrive folder does not exist yet', { folderPath });
        return { ...results, message: `Folder ${folderPath} not found. It will be created when Power Automate saves the first file.` };
      }
      throw folderError;
    }

    logger.info(`Found ${files.length} files in OneDrive folder`, { runId, folderPath });

    // Get already processed file IDs
    const processedResult = await db.query(
      `SELECT file_id FROM processed_files WHERE source = 'onedrive' AND processed_at >= NOW() - INTERVAL '${daysBack} days'`
    );
    const processedIds = new Set(processedResult.rows.map(r => r.file_id));

    // Filter to unprocessed files that look like Outcomes reports
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);

    const filesToProcess = files.filter(f => {
      // Skip already processed
      if (processedIds.has(f.id)) return false;

      // Must be a file (not folder)
      if (!f.file) return false;

      // Check filename pattern (Dispensing_Report*.csv or *.zip)
      const filename = f.name?.toLowerCase() || '';
      if (!filename.includes('dispensing') && !filename.includes('report')) return false;
      if (!filename.endsWith('.csv') && !filename.endsWith('.zip') && !filename.endsWith('.xlsx')) return false;

      // Check date
      const fileDate = new Date(f.createdDateTime);
      return fileDate >= cutoffDate;
    });

    logger.info(`Found ${filesToProcess.length} unprocessed report files`, { runId });

    // Process each file
    for (const file of filesToProcess) {
      try {
        logger.info('Processing OneDrive file', { runId, filename: file.name, size: file.size });

        // Download the file content
        const fileContent = await graphClient
          .api(`/me/drive/items/${file.id}/content`)
          .get();

        // Convert to Buffer
        let fileBuffer;
        if (fileContent instanceof ArrayBuffer) {
          fileBuffer = Buffer.from(fileContent);
        } else if (Buffer.isBuffer(fileContent)) {
          fileBuffer = fileContent;
        } else {
          // It might be a readable stream
          const chunks = [];
          for await (const chunk of fileContent) {
            chunks.push(chunk);
          }
          fileBuffer = Buffer.concat(chunks);
        }

        logger.info('Downloaded file', { filename: file.name, bufferSize: fileBuffer.length });

        // Extract CSVs (handle ZIP files)
        let csvFiles = [];
        const filename = file.name.toLowerCase();

        if (filename.endsWith('.zip')) {
          // Extract CSVs from ZIP
          try {
            const zip = new AdmZip(fileBuffer);
            const zipEntries = zip.getEntries();

            for (const entry of zipEntries) {
              if (entry.entryName.toLowerCase().endsWith('.csv') && !entry.isDirectory) {
                const csvData = zip.readFile(entry);
                csvFiles.push({
                  filename: entry.entryName,
                  data: csvData
                });
                logger.info('Extracted CSV from ZIP', { zipFile: file.name, csvFile: entry.entryName, size: csvData.length });
              }
            }
          } catch (zipError) {
            logger.error('Failed to extract ZIP', { filename: file.name, error: zipError.message });
            results.errors.push({ file: file.name, error: `ZIP extraction failed: ${zipError.message}` });
            continue;
          }
        } else if (filename.endsWith('.csv')) {
          csvFiles.push({
            filename: file.name,
            data: fileBuffer
          });
        }

        // Ingest each CSV
        for (const csv of csvFiles) {
          try {
            const ingestionResult = await ingestCSV(csv.data, {
              pharmacyId,
              sourceEmail: 'onedrive',
              sourceFile: csv.filename,
              pmsSystem: 'rx30'
            });

            results.recordsIngested += ingestionResult.stats?.inserted || 0;
            logger.info('Ingested CSV', {
              filename: csv.filename,
              inserted: ingestionResult.stats?.inserted,
              duplicates: ingestionResult.stats?.duplicates
            });

            // Auto-complete opportunities
            const newRxResult = await db.query(`
              SELECT p.*, pat.first_name as patient_first, pat.last_name as patient_last
              FROM prescriptions p
              LEFT JOIN patients pat ON pat.patient_id = p.patient_id
              WHERE p.pharmacy_id = $1
              AND p.source_file = $2
              AND p.created_at >= NOW() - INTERVAL '1 hour'
            `, [pharmacyId, csv.filename]);

            if (newRxResult.rows.length > 0) {
              const autoCompleteResult = await autoCompleteOpportunities(pharmacyId, newRxResult.rows);
              results.opportunitiesCompleted += autoCompleteResult.updated || 0;
            }

            // Run opportunity scan
            const scanResult = await runOpportunityScan({
              pharmacyIds: [pharmacyId],
              scanType: 'onedrive_import',
              lookbackHours: 1
            });
            results.newOpportunitiesFound += scanResult.opportunitiesFound || 0;

          } catch (csvError) {
            logger.error('Failed to ingest CSV', { filename: csv.filename, error: csvError.message });
            results.errors.push({ file: csv.filename, error: csvError.message });
          }
        }

        results.filesProcessed++;

        // Mark file as processed
        await db.query(`
          INSERT INTO processed_files (file_id, filename, source, processed_at, run_id)
          VALUES ($1, $2, 'onedrive', NOW(), $3)
          ON CONFLICT (file_id) DO UPDATE SET processed_at = NOW()
        `, [file.id, file.name, runId]);

      } catch (fileError) {
        logger.error('Failed to process OneDrive file', { filename: file.name, error: fileError.message });
        results.errors.push({ file: file.name, error: fileError.message });
      }
    }

    // Log the run
    await db.query(`
      INSERT INTO poll_runs (run_id, run_type, pharmacy_id, started_at, completed_at, summary)
      VALUES ($1, 'onedrive_poll', $2, NOW(), NOW(), $3)
    `, [runId, pharmacyId, JSON.stringify(results)]);

    logger.info('OneDrive poll completed', results);
    return results;

  } catch (error) {
    logger.error('OneDrive poll failed', { runId, error: error.message });
    results.errors.push({ general: error.message });
    return results;
  }
}

export default {
  getMicrosoftAuthUrl,
  handleMicrosoftOAuthCallback,
  pollForOutcomesReports,
  pollOneDriveForReports
};
