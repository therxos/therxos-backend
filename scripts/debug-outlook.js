#!/usr/bin/env node
// Debug script to see what emails are in the Outlook inbox

import 'dotenv/config';
import puppeteer from 'puppeteer';

async function main() {
  console.log('Launching browser...');

  const browser = await puppeteer.launch({
    headless: false, // Show browser for debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  console.log('Navigating to Outlook...');
  await page.goto('https://outlook.office.com/', { waitUntil: 'networkidle2' });

  // Login
  const email = process.env.MICROSOFT_EMAIL || 'StanleyWarren@therxos.onmicrosoft.com';
  const password = process.env.MICROSOFT_PASSWORD;

  console.log('Logging in as:', email);

  await page.waitForSelector('input[type="email"]', { timeout: 30000 });
  await page.type('input[type="email"]', email, { delay: 50 });
  await page.click('input[type="submit"]');

  await page.waitForSelector('input[type="password"]', { timeout: 30000 });
  await new Promise(r => setTimeout(r, 1000));
  await page.type('input[type="password"]', password, { delay: 50 });
  await page.click('input[type="submit"]');

  // Handle "Stay signed in?"
  try {
    await page.waitForSelector('input[value="No"], input[value="Yes"], #idBtn_Back', { timeout: 10000 });
    const yesButton = await page.$('input[value="Yes"]');
    if (yesButton) await yesButton.click();
  } catch (e) {}

  // Wait for inbox to load
  console.log('Waiting for inbox...');
  await page.waitForSelector('[aria-label="Mail"], [data-icon-name="Mail"]', { timeout: 60000 });
  await new Promise(r => setTimeout(r, 3000));

  console.log('\n=== INBOX LOADED ===');
  console.log('Browser is open - check what emails are visible');
  console.log('Press Ctrl+C to close when done\n');

  // Keep browser open for manual inspection
  await new Promise(() => {}); // Never resolves - user must Ctrl+C
}

main().catch(console.error);
