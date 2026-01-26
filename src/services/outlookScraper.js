// Outlook Web Scraper for TheRxOS V2
// Uses Puppeteer to log into Outlook Web, decrypt and download Purview-encrypted attachments
// This bypasses the RPMSG limitation since Outlook Web auto-decrypts when viewing

import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import os from 'os';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { ingestCSV } from './ingestion.js';
import { runOpportunityScan } from './scanner.js';
import { autoCompleteOpportunities } from './gmailPoller.js';

// Puppeteer bundles its own Chrome, so we don't need to find system Chrome
// This function is kept for backward compatibility with puppeteer-core if needed
function getChromePath() {
  // If CHROME_PATH is set, use it (for puppeteer-core)
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }
  // Otherwise puppeteer will use its bundled Chrome
  return null;
}

/**
 * Log into Microsoft 365 Outlook Web
 */
async function loginToOutlook(page, email, password) {
  logger.info('Navigating to Outlook login...');

  await page.goto('https://outlook.office.com/', { waitUntil: 'networkidle2' });

  // Wait for and fill email
  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.type('input[type="email"]', email, { delay: 50 });
  await page.click('input[type="submit"]');

  // Wait for password field
  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000)); // Small delay for page transition
  await page.type('input[type="password"]', password, { delay: 50 });
  await page.click('input[type="submit"]');

  // Handle "Stay signed in?" prompt if it appears
  try {
    await page.waitForSelector('input[value="No"], input[value="Yes"], #idBtn_Back', { timeout: 10000 });
    // Click "Yes" to stay signed in (helps with session persistence)
    const yesButton = await page.$('input[value="Yes"]');
    if (yesButton) {
      await yesButton.click();
    } else {
      const noButton = await page.$('input[value="No"], #idBtn_Back');
      if (noButton) await noButton.click();
    }
  } catch (e) {
    // Prompt may not appear, continue
  }

  // Wait for Outlook to load
  await page.waitForSelector('[aria-label="Mail"], [data-icon-name="Mail"]', { timeout: 60000 });
  logger.info('Successfully logged into Outlook');
}

/**
 * Search for emails from Outcomes
 */
async function findOutcomesEmails(page, daysBack = 7) {
  logger.info('Searching for Outcomes emails...');

  // Click on search box
  const searchBox = await page.waitForSelector('input[aria-label*="Search"], input[placeholder*="Search"]', { timeout: 30000 });
  await searchBox.click();

  // Search for Outcomes emails
  await page.type('input[aria-label*="Search"], input[placeholder*="Search"]', 'from:rxinsights_noreply@outcomes.com subject:Dispensing Report', { delay: 30 });
  await page.keyboard.press('Enter');

  // Wait for search results
  await new Promise(r => setTimeout(r, 3000));

  // Get email items
  const emails = await page.$$('[role="option"][aria-label*="Dispensing Report"], [role="listitem"][aria-label*="Dispensing Report"]');

  logger.info(`Found ${emails.length} potential Outcomes emails`);
  return emails;
}

/**
 * Process a single email - open it, download attachments
 */
async function processEmail(page, emailElement, downloadPath) {
  const attachments = [];

  try {
    // Click on the email to open it
    await emailElement.click();
    await new Promise(r => setTimeout(r, 3000)); // Wait for email to load and decrypt

    // Look for attachment icons/links
    const attachmentSelectors = [
      '[aria-label*=".csv"]',
      '[aria-label*="Download"]',
      '[data-icon-name="Attach"]',
      'button[aria-label*="attachment"]',
      '.attachmentItem',
      '[role="button"][aria-label*=".csv"]'
    ];

    for (const selector of attachmentSelectors) {
      const attachmentElements = await page.$$(selector);
      for (const el of attachmentElements) {
        try {
          const ariaLabel = await el.evaluate(e => e.getAttribute('aria-label') || e.textContent);
          if (ariaLabel && ariaLabel.toLowerCase().includes('.csv')) {
            logger.info(`Found CSV attachment: ${ariaLabel}`);

            // Try to download
            // Set up download handling
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
              behavior: 'allow',
              downloadPath: downloadPath
            });

            // Right-click and download or direct click
            await el.click();
            await new Promise(r => setTimeout(r, 2000));

            // Check for download menu
            const downloadButton = await page.$('[aria-label*="Download"], [data-icon-name="Download"]');
            if (downloadButton) {
              await downloadButton.click();
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        } catch (e) {
          logger.warn('Error processing attachment element', { error: e.message });
        }
      }
    }

    // Alternative: Try to find and click the attachment area directly
    const attachmentArea = await page.$('[aria-label*="attachment"], .attachment-well, [data-testid*="attachment"]');
    if (attachmentArea) {
      await attachmentArea.click();
      await new Promise(r => setTimeout(r, 1000));

      // Look for download all or individual download
      const downloadAll = await page.$('[aria-label*="Download all"], [aria-label*="download"]');
      if (downloadAll) {
        await downloadAll.click();
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    // Check download directory for new files
    if (fs.existsSync(downloadPath)) {
      const files = fs.readdirSync(downloadPath);
      for (const file of files) {
        if (file.toLowerCase().endsWith('.csv')) {
          const filePath = path.join(downloadPath, file);
          const data = fs.readFileSync(filePath);
          attachments.push({
            filename: file,
            data: data,
            size: data.length
          });
          logger.info(`Downloaded CSV: ${file}, size: ${data.length}`);
        }
      }
    }

  } catch (error) {
    logger.error('Error processing email', { error: error.message });
  }

  return attachments;
}

/**
 * Main scraper function
 */
export async function scrapeOutcomesEmails(options = {}) {
  const { pharmacyId, daysBack = 7 } = options;
  const runId = uuidv4();
  const downloadPath = path.join(os.tmpdir(), `therxos-downloads-${runId}`);

  // Create download directory
  fs.mkdirSync(downloadPath, { recursive: true });

  const results = {
    runId,
    emailsProcessed: 0,
    attachmentsDownloaded: 0,
    recordsIngested: 0,
    opportunitiesCompleted: 0,
    newOpportunitiesFound: 0,
    errors: []
  };

  let browser;

  try {
    // Get M365 credentials from environment or database
    const email = process.env.MICROSOFT_EMAIL || 'StanleyWarren@therxos.onmicrosoft.com';
    const password = process.env.MICROSOFT_PASSWORD;

    if (!password) {
      throw new Error('MICROSOFT_PASSWORD environment variable not set');
    }

    logger.info('Starting Outlook scraper', { runId, pharmacyId, daysBack });

    // Launch browser (puppeteer uses bundled Chrome)
    const launchOptions = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    };

    // Use custom Chrome path if set (for puppeteer-core compatibility)
    const chromePath = getChromePath();
    if (chromePath) {
      launchOptions.executablePath = chromePath;
      logger.info('Using Chrome at:', chromePath);
    }

    browser = await puppeteer.launch(launchOptions);

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Set download behavior
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath
    });

    // Login
    await loginToOutlook(page, email, password);

    // Find emails
    const emails = await findOutcomesEmails(page, daysBack);

    // Process each email (limit to prevent overload)
    const maxEmails = Math.min(emails.length, 10);
    for (let i = 0; i < maxEmails; i++) {
      try {
        // Re-query emails since DOM may have changed
        const currentEmails = await page.$$('[role="option"][aria-label*="Dispensing Report"], [role="listitem"][aria-label*="Dispensing Report"]');
        if (i >= currentEmails.length) break;

        logger.info(`Processing email ${i + 1} of ${maxEmails}`);
        const attachments = await processEmail(page, currentEmails[i], downloadPath);
        results.emailsProcessed++;

        // Ingest downloaded CSVs
        for (const attachment of attachments) {
          try {
            results.attachmentsDownloaded++;

            const ingestionResult = await ingestCSV(attachment.data, {
              pharmacyId,
              sourceEmail: 'rxinsights_noreply@outcomes.com',
              sourceFile: attachment.filename,
              pmsSystem: 'rx30'
            });

            results.recordsIngested += ingestionResult.stats?.inserted || 0;

            // Auto-complete opportunities
            const recentRx = await db.query(`
              SELECT p.*, pat.first_name as patient_first, pat.last_name as patient_last
              FROM prescriptions p
              LEFT JOIN patients pat ON pat.patient_id = p.patient_id
              WHERE p.pharmacy_id = $1
              AND p.source_file = $2
              AND p.created_at >= NOW() - INTERVAL '1 hour'
            `, [pharmacyId, attachment.filename]);

            if (recentRx.rows.length > 0) {
              const autoCompleteResult = await autoCompleteOpportunities(pharmacyId, recentRx.rows);
              results.opportunitiesCompleted += autoCompleteResult.updated || 0;
            }

            // Run opportunity scan
            const scanResult = await runOpportunityScan({
              pharmacyIds: [pharmacyId],
              scanType: 'outlook_scrape',
              lookbackHours: 1
            });
            results.newOpportunitiesFound += scanResult.opportunitiesFound || 0;

            logger.info('Processed attachment', {
              filename: attachment.filename,
              records: ingestionResult.stats?.inserted,
              completed: results.opportunitiesCompleted
            });

          } catch (ingestionError) {
            results.errors.push({ file: attachment.filename, error: ingestionError.message });
            logger.error('Ingestion error', { file: attachment.filename, error: ingestionError.message });
          }
        }

        // Go back to email list for next email
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 1000));

      } catch (emailError) {
        results.errors.push({ email: i, error: emailError.message });
        logger.error('Email processing error', { index: i, error: emailError.message });
      }
    }

    // Log the run
    await db.query(`
      INSERT INTO poll_runs (run_id, run_type, pharmacy_id, started_at, completed_at, summary)
      VALUES ($1, 'outlook_scrape', $2, NOW(), NOW(), $3)
    `, [runId, pharmacyId, JSON.stringify(results)]);

    logger.info('Outlook scraper completed', results);

  } catch (error) {
    logger.error('Outlook scraper failed', { runId, error: error.message });
    results.errors.push({ general: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }

    // Cleanup download directory
    try {
      fs.rmSync(downloadPath, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  }

  return results;
}

export default {
  scrapeOutcomesEmails
};
