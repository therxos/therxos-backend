// Hybrid Outlook Scraper for TheRxOS V2
// Uses Graph API to find emails + Puppeteer to decrypt and download
// This approach is more reliable than pure Puppeteer navigation

import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import os from 'os';
import AdmZip from 'adm-zip';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { ingestCSV } from './ingestion.js';
import { runOpportunityScan } from './scanner.js';
import { autoCompleteOpportunities } from './gmailPoller.js';
import { Client } from '@microsoft/microsoft-graph-client';

/**
 * Get Graph client using stored tokens
 */
async function getGraphClient() {
  const tokenResult = await db.query(
    "SELECT token_data FROM system_settings WHERE setting_key = 'microsoft_oauth_tokens'"
  );

  if (tokenResult.rows.length === 0) {
    throw new Error('Microsoft OAuth tokens not configured');
  }

  const tokenData = tokenResult.rows[0].token_data;
  const tokens = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

  const client = Client.init({
    authProvider: (done) => {
      done(null, tokens.accessToken);
    }
  });

  return client;
}

/**
 * Get Outcomes emails with their OWA links
 */
async function getOutcomesEmailsWithLinks(graphClient, daysBack = 7) {
  const allMessages = await graphClient
    .api('/me/messages')
    .select('id,subject,from,receivedDateTime,hasAttachments,body')
    .top(50)
    .orderby('receivedDateTime desc')
    .get();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);

  const outcomesEmails = allMessages.value.filter(m => {
    const from = m.from?.emailAddress?.address?.toLowerCase() || '';
    const receivedDate = new Date(m.receivedDateTime);
    return from.includes('outcomes.com') && receivedDate >= cutoffDate;
  });

  // Extract OWA links from email bodies
  const emailsWithLinks = outcomesEmails.map(msg => {
    const body = msg.body?.content || '';

    // Look for the "Read the message" link
    const linkRegex = /href="([^"]*outlook[^"]*viewmodel=ReadMessageItem[^"]*)"/i;
    const match = linkRegex.exec(body);

    let owaLink = null;
    if (match) {
      // Decode HTML entities
      owaLink = match[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/%3c/gi, '<')
        .replace(/%3e/gi, '>');
    }

    return {
      id: msg.id,
      subject: msg.subject,
      from: msg.from?.emailAddress?.address,
      receivedDateTime: msg.receivedDateTime,
      owaLink: owaLink
    };
  });

  return emailsWithLinks.filter(e => e.owaLink);
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
  await new Promise(r => setTimeout(r, 1000));
  await page.type('input[type="password"]', password, { delay: 50 });
  await page.click('input[type="submit"]');

  // Handle "Stay signed in?" prompt
  try {
    await page.waitForFunction(
      () => document.body?.innerText?.includes('Stay signed in'),
      { timeout: 15000 }
    );
    logger.info('Stay signed in prompt detected');
    await new Promise(r => setTimeout(r, 1000));

    // Click "Yes"
    const yesButton = await page.$('#idSIButton9');
    if (yesButton) {
      await yesButton.click();
    } else {
      await page.keyboard.press('Enter');
    }
    await new Promise(r => setTimeout(r, 3000));
  } catch (e) {
    logger.info('No stay signed in prompt');
  }

  // Wait for Outlook to load
  await new Promise(r => setTimeout(r, 5000));
  logger.info('Logged into Outlook');
}

/**
 * Click on an email in the list and download its attachments
 */
async function openEmailAndDownload(page, emailSelector, downloadPath) {
  const attachments = [];

  // Click on the email to open it in reading pane
  logger.info('Clicking email to open in reading pane...');

  const emailClicked = await page.evaluate((selector) => {
    const listItems = document.querySelectorAll('[role="option"], [data-convid]');

    for (const item of listItems) {
      const text = item.textContent || '';
      const ariaLabel = item.getAttribute('aria-label') || '';

      if (text.toLowerCase().includes('dispensing report') ||
          ariaLabel.toLowerCase().includes('dispensing report') ||
          text.toLowerCase().includes('outcomes')) {
        item.click();
        return { clicked: true, text: text.substring(0, 80) };
      }
    }
    return { clicked: false };
  }, emailSelector);

  if (!emailClicked.clicked) {
    logger.warn('Could not click on email in list');
    return attachments;
  }

  logger.info(`Clicked email: ${emailClicked.text}`);

  // Wait for reading pane to load
  await new Promise(r => setTimeout(r, 5000));

  // Look for attachments in the reading pane
  // OWA shows attachments with filename and size (e.g., "Dispensing_Report_2026-01-... 248 KB")
  const attachmentInfo = await page.evaluate(() => {
    const results = [];
    const allElements = document.querySelectorAll('*');

    for (const el of allElements) {
      const text = (el.textContent || '').trim();
      const ariaLabel = el.getAttribute('aria-label') || '';

      // Look for attachment indicators: filename with KB/MB size
      if ((text.includes('KB') || text.includes('MB')) &&
          (text.includes('Report') || text.includes('.zip') || text.includes('.csv')) &&
          text.length < 150) {
        // Make sure we're not in the email list area
        if (!el.closest('[role="listbox"]') && !el.closest('[role="option"]')) {
          results.push({
            text: text.substring(0, 100),
            ariaLabel: ariaLabel.substring(0, 100),
            tagName: el.tagName,
            className: el.className?.substring?.(0, 50) || ''
          });
        }
      }
    }
    return results.slice(0, 5);
  });

  logger.info('Attachments found in reading pane:', JSON.stringify(attachmentInfo));

  // Click on attachment to download
  // In OWA, clicking on an attachment usually opens a menu with Download option
  const clickResult = await page.evaluate(() => {
    // Find all elements that could be attachments (with file size indicator)
    const allElements = document.querySelectorAll('div, span, button, a');

    for (const el of allElements) {
      const text = (el.textContent || '').trim();
      const ariaLabel = el.getAttribute('aria-label') || '';

      // Skip email list items
      if (el.closest('[role="listbox"]') || el.closest('[role="option"]')) {
        continue;
      }

      // Look for attachment with filename pattern and size
      if ((text.includes('Dispensing_Report') || text.includes('Report_2026')) &&
          (text.includes('KB') || text.includes('MB'))) {
        el.click();
        return { clicked: true, what: text.substring(0, 80), method: 'attachment-text' };
      }

      // Also try aria-label
      if (ariaLabel.includes('Dispensing') && ariaLabel.includes('attachment')) {
        el.click();
        return { clicked: true, what: ariaLabel.substring(0, 80), method: 'attachment-aria' };
      }
    }

    // Try clicking any element with .zip or .csv in aria-label
    for (const el of allElements) {
      const ariaLabel = el.getAttribute('aria-label') || '';
      if ((ariaLabel.includes('.zip') || ariaLabel.includes('.csv')) &&
          !el.closest('[role="listbox"]')) {
        el.click();
        return { clicked: true, what: ariaLabel.substring(0, 80), method: 'file-extension' };
      }
    }

    return { clicked: false };
  });

  logger.info('Attachment click result:', JSON.stringify(clickResult));

  if (clickResult.clicked) {
    // Wait for context menu to appear
    await new Promise(r => setTimeout(r, 2000));

    // Look for Download option in menu
    const downloadClicked = await page.evaluate(() => {
      // Look for menu items with "Download"
      const menuItems = document.querySelectorAll('[role="menuitem"], [role="option"], button');

      for (const item of menuItems) {
        const text = (item.textContent || '').trim().toLowerCase();
        const ariaLabel = (item.getAttribute('aria-label') || '').toLowerCase();

        if (text.includes('download') || ariaLabel.includes('download')) {
          item.click();
          return { clicked: true, text: text.substring(0, 50) };
        }
      }

      // Also try clicking save buttons
      for (const item of menuItems) {
        const text = (item.textContent || '').trim().toLowerCase();
        if (text.includes('save') || text.includes('open')) {
          item.click();
          return { clicked: true, text: text.substring(0, 50) };
        }
      }

      return { clicked: false };
    });

    logger.info('Download menu click:', JSON.stringify(downloadClicked));
  }

  // Wait for download to complete
  logger.info('Waiting for download to complete...');
  await new Promise(r => setTimeout(r, 8000));

  // Check download directory for new files
  if (fs.existsSync(downloadPath)) {
    const files = fs.readdirSync(downloadPath);
    logger.info(`Files in download directory: ${files.join(', ') || 'none'}`);

    for (const file of files) {
      const filePath = path.join(downloadPath, file);

      // Skip incomplete downloads
      if (file.endsWith('.crdownload') || file.endsWith('.tmp')) {
        continue;
      }

      // Handle ZIP files
      if (file.toLowerCase().endsWith('.zip')) {
        logger.info(`Extracting ZIP: ${file}`);
        try {
          const zip = new AdmZip(filePath);
          const zipEntries = zip.getEntries();

          for (const entry of zipEntries) {
            if (entry.entryName.toLowerCase().endsWith('.csv') && !entry.isDirectory) {
              const csvData = zip.readFile(entry);
              attachments.push({
                filename: path.basename(entry.entryName), // Just the filename without directory
                data: csvData,
                size: csvData.length,
                fromZip: file
              });
              logger.info(`Extracted CSV: ${entry.entryName} (${csvData.length} bytes)`);
            }
          }

          // Delete the ZIP after extraction
          fs.unlinkSync(filePath);
        } catch (zipError) {
          logger.error('ZIP extraction error:', zipError.message);
        }
      }

      // Handle CSV files directly
      if (file.toLowerCase().endsWith('.csv')) {
        const data = fs.readFileSync(filePath);
        attachments.push({
          filename: file,
          data: data,
          size: data.length
        });
        logger.info(`Downloaded CSV: ${file} (${data.length} bytes)`);

        // Delete after reading
        fs.unlinkSync(filePath);
      }
    }
  }

  return attachments;
}

/**
 * Main hybrid scraper function
 */
export async function scrapeOutcomesHybrid(options = {}) {
  const { pharmacyId, daysBack = 7 } = options;
  const runId = uuidv4();
  const downloadPath = path.join(os.tmpdir(), `therxos-hybrid-${runId}`);

  // Create download directory
  fs.mkdirSync(downloadPath, { recursive: true });

  const results = {
    runId,
    source: 'hybrid_scraper',
    emailsFound: 0,
    emailsProcessed: 0,
    attachmentsDownloaded: 0,
    recordsIngested: 0,
    opportunitiesCompleted: 0,
    newOpportunitiesFound: 0,
    errors: []
  };

  let browser;

  try {
    // Step 1: Use Graph API to find Outcomes emails with OWA links
    logger.info('Fetching Outcomes emails via Graph API...');
    const graphClient = await getGraphClient();
    const emails = await getOutcomesEmailsWithLinks(graphClient, daysBack);

    results.emailsFound = emails.length;
    logger.info(`Found ${emails.length} Outcomes emails with OWA links`);

    if (emails.length === 0) {
      logger.info('No Outcomes emails found');
      return results;
    }

    // Check which emails have already been processed
    const processedResult = await db.query(
      `SELECT message_id FROM processed_emails WHERE source = 'hybrid_scraper' AND processed_at >= NOW() - INTERVAL '${daysBack + 1} days'`
    );
    const processedIds = new Set(processedResult.rows.map(r => r.message_id));

    const emailsToProcess = emails.filter(e => !processedIds.has(e.id));
    logger.info(`${emailsToProcess.length} emails to process (${emails.length - emailsToProcess.length} already processed)`);

    if (emailsToProcess.length === 0) {
      logger.info('All emails already processed');
      return results;
    }

    // Step 2: Launch Puppeteer and login
    const email = process.env.MICROSOFT_EMAIL;
    const password = process.env.MICROSOFT_PASSWORD;

    if (!email || !password) {
      throw new Error('MICROSOFT_EMAIL and MICROSOFT_PASSWORD required');
    }

    const headless = process.env.HEADLESS !== 'false';
    browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    // Set up download handling
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath
    });

    // Login once
    await loginToOutlook(page, email, password);

    // Step 3: Search for Outcomes emails and process them
    logger.info('Searching for Outcomes emails in Outlook...');

    // Use Outlook search to find Outcomes emails
    const searchInput = await page.$('input[aria-label*="Search"], input[placeholder*="Search"]');
    if (searchInput) {
      await searchInput.click();
      await new Promise(r => setTimeout(r, 1000));
      await page.keyboard.type('from:outcomes.com dispensing report', { delay: 30 });
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 5000));
    }

    // Process emails one by one
    const maxEmails = Math.min(emailsToProcess.length, 10);
    for (let i = 0; i < maxEmails; i++) {
      const emailData = emailsToProcess[i];

      try {
        logger.info(`Processing email ${i + 1}/${maxEmails}: ${emailData.subject}`);

        const attachments = await openEmailAndDownload(page, emailData.subject, downloadPath);
        results.emailsProcessed++;

        // Ingest downloaded attachments
        for (const attachment of attachments) {
          try {
            results.attachmentsDownloaded++;

            const ingestionResult = await ingestCSV(attachment.data, {
              pharmacyId,
              sourceEmail: emailData.from,
              sourceFile: attachment.filename,
              pmsSystem: 'rx30'
            });

            results.recordsIngested += ingestionResult.stats?.inserted || 0;
            logger.info(`Ingested ${attachment.filename}: ${ingestionResult.stats?.inserted} records`);

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
              scanType: 'hybrid_scrape',
              lookbackHours: 1
            });
            results.newOpportunitiesFound += scanResult.opportunitiesFound || 0;

          } catch (ingestionError) {
            results.errors.push({ file: attachment.filename, error: ingestionError.message });
            logger.error('Ingestion error:', ingestionError.message);
          }
        }

        // Mark email as processed
        await db.query(`
          INSERT INTO processed_emails (email_id, message_id, source, processed_at, job_id, results)
          VALUES ($1, $2, 'hybrid_scraper', NOW(), $3, $4)
          ON CONFLICT (message_id) DO UPDATE SET processed_at = NOW(), results = $4
        `, [uuidv4(), emailData.id, runId, JSON.stringify({ attachments: attachments.length })]);

        // Go back to email list for next email
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 2000));

        // Click somewhere in the email list to deselect
        await page.evaluate(() => {
          const listbox = document.querySelector('[role="listbox"]');
          if (listbox) listbox.click();
        });
        await new Promise(r => setTimeout(r, 1000));

      } catch (emailError) {
        results.errors.push({ email: emailData.subject, error: emailError.message });
        logger.error('Email processing error:', emailError.message);
      }
    }

    // Log the run
    await db.query(`
      INSERT INTO poll_runs (run_id, run_type, pharmacy_id, started_at, completed_at, summary)
      VALUES ($1, 'hybrid_scrape', $2, NOW(), NOW(), $3)
    `, [runId, pharmacyId, JSON.stringify(results)]);

    logger.info('Hybrid scraper completed', results);

  } catch (error) {
    logger.error('Hybrid scraper failed:', error.message);
    results.errors.push({ general: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }

    // Cleanup
    try {
      fs.rmSync(downloadPath, { recursive: true, force: true });
    } catch (e) {}
  }

  return results;
}

export default { scrapeOutcomesHybrid };
