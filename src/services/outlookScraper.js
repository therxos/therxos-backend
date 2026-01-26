// Outlook Web Scraper for TheRxOS V2
// Uses Puppeteer to log into Outlook Web, decrypt and download Purview-encrypted attachments
// This bypasses the RPMSG limitation since Outlook Web auto-decrypts when viewing

import puppeteer from 'puppeteer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { createUnzip } from 'zlib';
import AdmZip from 'adm-zip';
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
    // Wait for the page to show the "Stay signed in" prompt
    // Check for text "Stay signed in" as it's more reliable than button selectors
    await page.waitForFunction(
      () => document.body?.innerText?.includes('Stay signed in'),
      { timeout: 20000 }
    );
    logger.info('Stay signed in prompt detected (via text)');

    // Wait a moment for the page to be fully interactive
    await new Promise(r => setTimeout(r, 1000));

    // The "Yes" button is typically input[type="submit"][value="Yes"] or #idSIButton9
    // Try clicking directly with page.click which handles visibility/clickability better
    const yesSelectors = [
      '#idSIButton9',
      'input[type="submit"][value="Yes"]',
      'input[value="Yes"]',
      'button[type="submit"]'
    ];

    let clicked = false;
    for (const selector of yesSelectors) {
      try {
        // Check if element exists and is visible
        const yesButton = await page.$(selector);
        if (yesButton) {
          const isVisible = await yesButton.evaluate(el => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden';
          });

          if (isVisible) {
            // Use page.click which handles scrolling and waiting better
            await page.click(selector);
            logger.info(`Clicked yes button with selector: ${selector}`);
            clicked = true;
            break;
          }
        }
      } catch (e) {
        logger.warn(`Failed to click ${selector}`, { error: e.message });
      }
    }

    if (!clicked) {
      // Try using Tab to navigate to the Yes button and Enter to click
      logger.info('Trying keyboard navigation to click Yes...');
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 200));
      await page.keyboard.press('Tab');
      await new Promise(r => setTimeout(r, 200));
      await page.keyboard.press('Enter');
      logger.info('Pressed Enter after Tab navigation');
    }

    // Wait for navigation after clicking
    await new Promise(r => setTimeout(r, 5000));

    // Double-check: if still on login page, try evaluate click
    const stillOnLogin = await page.evaluate(() => document.body?.innerText?.includes('Stay signed in'));
    if (stillOnLogin) {
      logger.info('Still on Stay signed in page, trying evaluate click...');
      await page.evaluate(() => {
        // Find any button/input with "Yes" text
        const allElements = document.querySelectorAll('input, button');
        for (const el of allElements) {
          const text = el.value || el.textContent || '';
          if (text.includes('Yes')) {
            el.click();
            return;
          }
        }
      });
      await new Promise(r => setTimeout(r, 5000));
    }

  } catch (e) {
    logger.info('No stay signed in prompt or already dismissed', { message: e.message });
  }

  // Wait for Outlook to load - try multiple possible selectors
  // Make sure we're on the Outlook domain first
  const maxWaitTime = 60000;
  const startTime = Date.now();

  while (Date.now() - startTime < maxWaitTime) {
    const url = page.url();
    logger.info(`Current URL: ${url}`);

    // Check if we're on Outlook domain
    if (url.includes('outlook.office') || url.includes('outlook.live') || url.includes('outlook.com/mail')) {
      logger.info('On Outlook domain, checking for inbox...');

      // Now look for Outlook-specific elements
      const outlookLoadedSelectors = [
        '[aria-label="Mail"]',
        '[data-icon-name="Mail"]',
        '[aria-label="Inbox"]',
        '[aria-label="New mail"]',
        '[aria-label="Message list"]',
        '.ms-FocusZone'
      ];

      for (const selector of outlookLoadedSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 5000 });
          logger.info(`Outlook loaded (detected via: ${selector})`);
          logger.info('Successfully logged into Outlook');
          return;
        } catch (e) {
          // Try next selector
        }
      }
    }

    // Not on Outlook yet, wait a bit
    await new Promise(r => setTimeout(r, 2000));
  }

  // Last resort - just proceed and hope it works
  logger.warn('Outlook load detection timed out, proceeding anyway');
}

/**
 * Navigate to a specific mail folder
 */
async function navigateToFolder(page, folderName) {
  logger.info(`Navigating to folder: ${folderName}`);

  // Wait for folder list to load
  await new Promise(r => setTimeout(r, 2000));

  // Look for folder in the navigation pane
  const folderSelectors = [
    `[aria-label="${folderName}"]`,
    `[title="${folderName}"]`,
    `[aria-label*="${folderName}"]`,
    `span:has-text("${folderName}")`,
    `div[role="treeitem"][aria-label*="${folderName}"]`
  ];

  // First try to expand any collapsed folder sections
  const expandButtons = await page.$$('[aria-expanded="false"][aria-label*="folder"], [aria-label="Expand folder"]');
  for (const btn of expandButtons) {
    try {
      await btn.click();
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {}
  }

  // Try to find and click the folder
  for (const selector of folderSelectors) {
    try {
      const folderElement = await page.$(selector);
      if (folderElement) {
        logger.info(`Found folder with selector: ${selector}`);
        await folderElement.click();
        await new Promise(r => setTimeout(r, 3000));
        return true;
      }
    } catch (e) {}
  }

  // Try finding by text content
  try {
    const result = await page.evaluate((name) => {
      const elements = document.querySelectorAll('[role="treeitem"], [role="option"], div[draggable="true"]');
      for (const el of elements) {
        if (el.textContent.includes(name) || (el.getAttribute('aria-label') || '').includes(name)) {
          el.click();
          return true;
        }
      }
      return false;
    }, folderName);

    if (result) {
      logger.info('Found and clicked folder by text content');
      await new Promise(r => setTimeout(r, 3000));
      return true;
    }
  } catch (e) {}

  logger.warn(`Could not find folder: ${folderName}`);
  return false;
}

/**
 * Search for emails from Outcomes - directly from inbox without search
 */
async function findOutcomesEmails(page, daysBack = 7, folderName = null) {
  logger.info('Looking for Outcomes emails in inbox...');

  // Wait for inbox to fully load
  await new Promise(r => setTimeout(r, 3000));

  // Navigate to specific folder if provided
  if (folderName) {
    await navigateToFolder(page, folderName);
  } else {
    // Make sure we're in the inbox by clicking Inbox
    try {
      // Click the Inbox link in the folder pane
      const inboxLinks = await page.$$('[aria-label="Inbox"], [title="Inbox"]');
      for (const link of inboxLinks) {
        try {
          await link.click();
          await new Promise(r => setTimeout(r, 2000));
          break;
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Take a screenshot to see what we're looking at
  const screenshotPath = path.join(os.tmpdir(), `outlook-debug-${Date.now()}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  logger.info(`Debug screenshot saved to: ${screenshotPath}`);

  // Get all visible emails in inbox - look for the email list area
  const emailSelectors = [
    '[role="option"]',
    '[data-convid]',
    'div[draggable="true"][tabindex]'
  ];

  let allEmails = [];
  for (const selector of emailSelectors) {
    const found = await page.$$(selector);
    if (found.length > 0) {
      logger.info(`Found ${found.length} elements with selector: ${selector}`);
      allEmails = found;
      break;
    }
  }

  // Log some info about what emails we can see
  for (let i = 0; i < Math.min(5, allEmails.length); i++) {
    try {
      const ariaLabel = await allEmails[i].evaluate(el => el.getAttribute('aria-label') || el.textContent?.substring(0, 100));
      logger.info(`Email ${i}: ${ariaLabel?.substring(0, 80)}`);
    } catch (e) {}
  }

  // Filter to only Outcomes emails
  let outcomesEmails = [];
  for (const el of allEmails) {
    try {
      const ariaLabel = await el.evaluate(e => e.getAttribute('aria-label') || '');
      const textContent = await el.evaluate(e => e.textContent || '');

      if (ariaLabel.toLowerCase().includes('dispensing') ||
          ariaLabel.toLowerCase().includes('outcomes') ||
          ariaLabel.toLowerCase().includes('rxinsights') ||
          textContent.toLowerCase().includes('dispensing report')) {
        outcomesEmails.push(el);
        logger.info(`Found Outcomes email: ${ariaLabel.substring(0, 60)}`);
      }
    } catch (e) {}
  }

  logger.info(`Found ${outcomesEmails.length} Outcomes emails in inbox`);
  return outcomesEmails;
}

/**
 * Fallback: scan visible emails in inbox without search
 */
async function findEmailsInInbox(page) {
  logger.info('Falling back to scanning inbox directly...');

  // Get all email rows visible
  const emailRows = await page.$$('[role="option"], [role="listitem"], [data-convid]');
  const outcomesEmails = [];

  for (const row of emailRows) {
    const text = await row.evaluate(el => el.textContent || '');
    const ariaLabel = await row.evaluate(el => el.getAttribute('aria-label') || '');

    if (text.toLowerCase().includes('dispensing report') ||
        text.toLowerCase().includes('outcomes') ||
        ariaLabel.toLowerCase().includes('dispensing')) {
      outcomesEmails.push(row);
      logger.info('Found Outcomes email in inbox scan');
    }
  }

  logger.info(`Found ${outcomesEmails.length} Outcomes emails via inbox scan`);
  return outcomesEmails;
}

/**
 * Process a single email - open it, download attachments
 */
async function processEmail(initialPage, emailElement, downloadPath) {
  const attachments = [];
  let page = initialPage; // May change if new tab opens

  try {
    // Set up download handling FIRST
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadPath
    });

    // Make sure email element is visible and clickable
    await emailElement.scrollIntoViewIfNeeded();
    await new Promise(r => setTimeout(r, 500));

    // Click on the email to open it
    logger.info('Clicking email to open in reading pane...');

    // Get the email element's position and click in the center
    const bbox = await emailElement.boundingBox();
    if (bbox) {
      logger.info(`Email element position: x=${bbox.x}, y=${bbox.y}, w=${bbox.width}, h=${bbox.height}`);

      // Click in the center of the email item
      await page.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      await new Promise(r => setTimeout(r, 2000));
    }

    // Simple check: take a screenshot to see what happened
    const afterClickPath = path.join(os.tmpdir(), `after-click-${Date.now()}.png`);
    await page.screenshot({ path: afterClickPath, fullPage: false });
    logger.info(`After click screenshot: ${afterClickPath}`);

    // Wait and check if reading pane shows content
    await new Promise(r => setTimeout(r, 3000));

    // Try pressing Enter to ensure the email opens
    await page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 3000));

    // Take another screenshot
    const afterEnterPath = path.join(os.tmpdir(), `after-enter-${Date.now()}.png`);
    await page.screenshot({ path: afterEnterPath, fullPage: false });
    logger.info(`After Enter screenshot: ${afterEnterPath}`);

    // Now look for the attachment in the reading pane
    // The attachment shows as something like "Dispensing_Report_2026-01-..." with "97 KB" size
    logger.info('Looking for attachment in reading pane...');

    // Wait a moment for attachment area to fully load
    await new Promise(r => setTimeout(r, 2000));

    // Debug: Get all elements with their text to find the attachment
    const debugElements = await page.evaluate(() => {
      const results = [];
      const allElements = document.querySelectorAll('*');

      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        // Look for elements containing "KB" (file size indicator) or "Report"
        if ((text.includes('KB') || text.includes('Report_')) && text.length < 200) {
          // Skip if inside email list
          if (!el.closest('[role="option"]') && !el.closest('[role="listbox"]')) {
            results.push({
              text: text.substring(0, 100),
              tagName: el.tagName,
              className: el.className?.substring?.(0, 50) || '',
              id: el.id,
              ariaLabel: el.getAttribute('aria-label')?.substring(0, 50)
            });
          }
        }
      }
      return results.slice(0, 20);  // Limit results
    });

    logger.info('Debug - Elements containing KB or Report_:', JSON.stringify(debugElements, null, 2));

    // Try to find and click the attachment by looking for elements with file size
    const attachmentClicked = await page.evaluate(() => {
      const allElements = document.querySelectorAll('*');

      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        const ariaLabel = el.getAttribute('aria-label') || '';

        // Skip if inside email list
        if (el.closest('[role="option"]') || el.closest('[role="listbox"]')) {
          continue;
        }

        // Look for elements containing both filename pattern and file size
        if ((text.includes('Dispensing_Report') || text.includes('Report_2026')) &&
            text.includes('KB')) {
          // This is likely the attachment area - click it
          el.click();
          return { clicked: true, text: text.substring(0, 80) };
        }

        // Alternative: look for aria-label with attachment info
        if (ariaLabel.includes('Dispensing') && ariaLabel.includes('KB')) {
          el.click();
          return { clicked: true, ariaLabel: ariaLabel.substring(0, 80) };
        }
      }

      // Try finding by looking for "97 KB" specifically
      for (const el of allElements) {
        const text = (el.textContent || '').trim();
        if (text === '97 KB' || text.includes('97 KB')) {
          // Click the parent element which should be the attachment container
          const parent = el.parentElement;
          if (parent) {
            parent.click();
            return { clicked: true, method: 'clicked 97 KB parent', text: parent.textContent?.substring(0, 80) };
          }
        }
      }

      return { clicked: false };
    });

    logger.info('Attachment click result:', JSON.stringify(attachmentClicked));

    if (attachmentClicked.clicked) {
      // Take screenshot to see result
      const afterAttachmentClick = path.join(os.tmpdir(), `after-attachment-click-${Date.now()}.png`);
      await page.screenshot({ path: afterAttachmentClick, fullPage: false });
      logger.info(`After attachment click screenshot: ${afterAttachmentClick}`);

      // Wait for download menu or download to start
      await new Promise(r => setTimeout(r, 2000));

      // Look for "Download" option in any popup menu
      const downloadOption = await page.$('[aria-label*="Download"], [aria-label*="download"], [title*="Download"], [role="menuitem"]');
      if (downloadOption) {
        logger.info('Found download option, clicking...');
        await downloadOption.click();
        await new Promise(r => setTimeout(r, 5000));
      } else {
        // Try pressing Enter which might trigger download
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // For encrypted/Purview emails, we may need to click "Read the message" or similar
    // This often opens a new tab with the decrypted content
    const browser = page.browser();
    const pagesBefore = await browser.pages();

    // Check if email content is in an iframe (common for Purview-encrypted messages)
    const iframes = await page.$$('iframe');
    logger.info(`Found ${iframes.length} iframes on page`);

    let frameToSearch = page;
    for (const iframe of iframes) {
      try {
        const frame = await iframe.contentFrame();
        if (frame) {
          const frameContent = await frame.evaluate(() => document.body?.innerText?.substring(0, 200) || '');
          logger.info(`Iframe content preview: ${frameContent.substring(0, 100)}`);

          if (frameContent.includes('Read the message') || frameContent.includes('protected message')) {
            logger.info('Found Purview content in iframe');
            frameToSearch = frame;
            break;
          }
        }
      } catch (e) {
        logger.warn('Could not access iframe', { error: e.message });
      }
    }

    // Look specifically for anchor links with "Read the message" text
    // Note: :has-text() and :contains() are NOT valid CSS - must use page.evaluate instead
    const decryptButtons = [
      'a[href*="purview"]',
      'a[href*="protection.outlook"]',
      'a[aria-label*="Read the message"]',
      'button[aria-label*="Read the message"]',
      '[aria-label*="Read the message"]',
      '[aria-label*="View message"]',
      '[data-testid*="decrypt"]'
    ];

    // First, find the reading pane container (right side where email content displays)
    // This is typically a div with role="main" or the area that's NOT the email list
    const readingPaneInfo = await frameToSearch.evaluate(() => {
      // The reading pane is usually the main area or a specific container
      // Look for areas that contain the Purview message text
      const allElements = document.querySelectorAll('div, span, td');
      for (const el of allElements) {
        const text = el.textContent || '';
        // Find element that contains Purview text but is NOT an email list item
        if (text.includes('protected message') && text.includes('Read the message') && !el.closest('[role="option"]')) {
          // Found the reading pane content area
          return {
            found: true,
            html: el.innerHTML.substring(0, 1500),
            text: text.substring(0, 300)
          };
        }
      }
      return { found: false };
    });

    logger.info('Reading pane search:', readingPaneInfo.found ? 'Found Purview content' : 'Not found');
    if (readingPaneInfo.found) {
      logger.info('Reading pane HTML snippet:', readingPaneInfo.html?.substring(0, 300));
    }

    // Search specifically for anchor links in the reading pane area
    let decryptBtnFound = await frameToSearch.evaluate(() => {
      // Find all anchor tags on the page
      const links = document.querySelectorAll('a');

      for (const link of links) {
        // Skip links that are inside email list items
        if (link.closest('[role="option"]') || link.closest('[role="listitem"]')) {
          continue;
        }

        const text = link.textContent || '';
        const href = link.href || '';

        // Look for the Purview decrypt link
        if (text.includes('Read the message') || href.includes('protection.outlook') || href.includes('purview')) {
          return {
            href: href,
            text: text.substring(0, 50),
            target: link.target,
            tagName: 'A'
          };
        }
      }

      // Also try finding by searching within the reading pane area
      const readingArea = document.querySelector('[role="main"]') || document.querySelector('.ReadingPaneContainerClass');
      if (readingArea) {
        const readingLinks = readingArea.querySelectorAll('a');
        for (const link of readingLinks) {
          const text = link.textContent || '';
          if (text.includes('Read the message')) {
            return {
              href: link.href,
              text: text.substring(0, 50),
              target: link.target,
              tagName: 'A',
              inReadingPane: true
            };
          }
        }
      }

      return null;
    });

    if (decryptBtnFound) {
      logger.info(`Found decrypt link by text: ${JSON.stringify(decryptBtnFound)}`);
      if (decryptBtnFound.href) {
        // Open the link directly
        logger.info('Navigating to Purview decryption URL...');

        // Listen for new tab
        const newPagePromise = new Promise(resolve => {
          browser.once('targetcreated', async target => {
            const newPage = await target.page();
            resolve(newPage);
          });
        });

        // Click the link using evaluate on the correct frame
        await frameToSearch.evaluate(() => {
          const links = document.querySelectorAll('a');
          for (const link of links) {
            if (link.textContent.includes('Read the message')) {
              link.click();
              return;
            }
          }
        });

        // Wait for new page with timeout
        try {
          const newPage = await Promise.race([
            newPagePromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
          ]);

          if (newPage) {
            logger.info('New page opened for decrypted message');
            await newPage.waitForSelector('body', { timeout: 30000 });
            await new Promise(r => setTimeout(r, 5000));

            // Set download behavior on new page
            const newClient = await newPage.target().createCDPSession();
            await newClient.send('Page.setDownloadBehavior', {
              behavior: 'allow',
              downloadPath: downloadPath
            });

            page = newPage;
          }
        } catch (e) {
          logger.info('No new page opened, checking current page');
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    // Fallback: try selector-based approach
    for (const selector of decryptButtons) {
      try {
        const decryptBtn = await page.$(selector);
        if (decryptBtn) {
          // Get more info about the element
          const tagName = await decryptBtn.evaluate(el => el.tagName);
          const href = await decryptBtn.evaluate(el => el.href || el.getAttribute('href'));
          const target = await decryptBtn.evaluate(el => el.target || el.getAttribute('target'));
          logger.info(`Found decrypt element: tag=${tagName}, href=${href}, target=${target}`);

          // If it's a link with href, navigate directly
          if (href && href.startsWith('http')) {
            logger.info('Navigating directly to decrypt URL');

            // Listen for new page/popup
            const newPagePromise = new Promise(resolve => {
              browser.once('targetcreated', async target => {
                const newPage = await target.page();
                resolve(newPage);
              });
            });

            // Click the link
            await decryptBtn.click();

            // Wait for new page with timeout
            try {
              const newPage = await Promise.race([
                newPagePromise,
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
              ]);

              if (newPage) {
                logger.info('New page/popup opened for decrypted message');
                await newPage.waitForSelector('body', { timeout: 30000 });
                await new Promise(r => setTimeout(r, 5000));

                // Set download behavior on new page
                const newClient = await newPage.target().createCDPSession();
                await newClient.send('Page.setDownloadBehavior', {
                  behavior: 'allow',
                  downloadPath: downloadPath
                });

                page = newPage;
              }
            } catch (e) {
              logger.info('No new page opened, checking current page');
            }
          } else {
            // Regular click
            await decryptBtn.click();
            await new Promise(r => setTimeout(r, 5000));

            // Check if new tab opened
            const pagesAfter = await browser.pages();
            if (pagesAfter.length > pagesBefore.length) {
              const newPage = pagesAfter[pagesAfter.length - 1];
              logger.info('New tab opened for decrypted message');
              await newPage.waitForSelector('body', { timeout: 30000 });
              await new Promise(r => setTimeout(r, 5000));

              const newClient = await newPage.target().createCDPSession();
              await newClient.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
              });

              page = newPage;
            }
          }

          await new Promise(r => setTimeout(r, 3000));
          break;
        }
      } catch (e) {
        logger.warn('Error with decrypt button', { error: e.message, stack: e.stack });
      }
    }

    // Log what we can see on the page for debugging
    try {
      const pageText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || 'empty');
      logger.info('Page content preview:', pageText.substring(0, 200));
    } catch (e) {
      logger.info('Could not get page content preview');
    }

    // Look for attachment icons/links - expanded selectors
    const attachmentSelectors = [
      '[aria-label*=".csv"]',
      '[aria-label*="attachment"]',
      '[aria-label*="Attachment"]',
      '[data-icon-name="Attach"]',
      '[data-icon-name="OpenFile"]',
      'button[aria-label*="attachment"]',
      '.attachmentItem',
      '[role="button"][aria-label*=".csv"]',
      'span[title*=".csv"]',
      'div[title*=".csv"]',
      '[aria-label*="Download"]'
    ];

    let foundAttachment = false;
    for (const selector of attachmentSelectors) {
      const attachmentElements = await page.$$(selector);
      if (attachmentElements.length > 0) {
        logger.info(`Found ${attachmentElements.length} elements with selector: ${selector}`);
      }
      for (const el of attachmentElements) {
        try {
          const ariaLabel = await el.evaluate(e => e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent);
          logger.info(`Attachment element found: ${ariaLabel}`);

          if (ariaLabel && (ariaLabel.toLowerCase().includes('.csv') || ariaLabel.toLowerCase().includes('download'))) {
            logger.info(`Clicking attachment: ${ariaLabel}`);
            foundAttachment = true;

            // Click to select/download
            await el.click();
            await new Promise(r => setTimeout(r, 2000));

            // Check for download option in context menu or popup
            const downloadOptions = await page.$$('[aria-label*="Download"], [data-icon-name="Download"], [aria-label*="Save"]');
            for (const dl of downloadOptions) {
              try {
                await dl.click();
                await new Promise(r => setTimeout(r, 3000));
              } catch (e) {}
            }
          }
        } catch (e) {
          logger.warn('Error processing attachment element', { error: e.message });
        }
      }
    }

    if (!foundAttachment) {
      // Try to find attachment well/area
      const attachmentArea = await page.$('[aria-label*="attachment"], .attachment-well, [data-testid*="attachment"], [class*="attachment"]');
      if (attachmentArea) {
        logger.info('Found attachment area, clicking...');
        await attachmentArea.click();
        await new Promise(r => setTimeout(r, 2000));

        // Look for download option
        const downloadAll = await page.$('[aria-label*="Download"], [aria-label*="download"], [aria-label*="Save"]');
        if (downloadAll) {
          await downloadAll.click();
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }

    // Wait a bit more for download to complete
    await new Promise(r => setTimeout(r, 5000));

    // Check download directory for new files
    if (fs.existsSync(downloadPath)) {
      const files = fs.readdirSync(downloadPath);
      logger.info(`Files in download directory: ${files.join(', ') || 'none'}`);

      for (const file of files) {
        const filePath = path.join(downloadPath, file);

        // Handle ZIP files - extract and find CSVs
        if (file.toLowerCase().endsWith('.zip')) {
          logger.info(`Found ZIP file: ${file}, extracting...`);
          try {
            const zip = new AdmZip(filePath);
            const zipEntries = zip.getEntries();

            for (const entry of zipEntries) {
              if (entry.entryName.toLowerCase().endsWith('.csv') && !entry.isDirectory) {
                const csvData = zip.readFile(entry);
                attachments.push({
                  filename: entry.entryName,
                  data: csvData,
                  size: csvData.length,
                  fromZip: file
                });
                logger.info(`Extracted CSV from ZIP: ${entry.entryName}, size: ${csvData.length}`);
              }
            }
          } catch (zipError) {
            logger.error('Error extracting ZIP', { file, error: zipError.message });
          }
        }

        // Also handle direct CSV files
        if (file.toLowerCase().endsWith('.csv')) {
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
  const { pharmacyId, daysBack = 7, folderName = null } = options;
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
    // Set HEADLESS=false env var to see browser for debugging
    const headless = process.env.HEADLESS !== 'false';
    const launchOptions = {
      headless: headless ? 'new' : false,
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
    const emails = await findOutcomesEmails(page, daysBack, folderName);

    // Process each email (limit to prevent overload)
    const maxEmails = Math.min(emails.length, 10);
    for (let i = 0; i < maxEmails; i++) {
      try {
        // Re-query emails since DOM may have changed
        const currentEmails = await findOutcomesEmails(page, daysBack, folderName);
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
