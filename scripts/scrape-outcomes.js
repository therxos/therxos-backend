#!/usr/bin/env node
// Standalone script to scrape Outcomes emails from Outlook Web
// Run this via cron or Windows Task Scheduler
//
// Usage:
//   node scripts/scrape-outcomes.js
//
// Required environment variables:
//   DATABASE_URL - Supabase connection string
//   MICROSOFT_PASSWORD - Password for StanleyWarren@therxos.onmicrosoft.com
//
// Optional:
//   MICROSOFT_EMAIL - Override email (default: StanleyWarren@therxos.onmicrosoft.com)
//   DAYS_BACK - How many days to look back (default: 3)

import 'dotenv/config';
import { scrapeOutcomesEmails } from '../src/services/outlookScraper.js';
import db from '../src/database/index.js';

// Aracoma pharmacy ID
const ARACOMA_PHARMACY_ID = '5b77e7f0-66c0-4f1b-b307-deeed69354c9';

async function main() {
  console.log('='.repeat(60));
  console.log('TheRxOS Outcomes Email Scraper');
  console.log('Started at:', new Date().toISOString());
  console.log('='.repeat(60));

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable not set');
    process.exit(1);
  }

  if (!process.env.MICROSOFT_PASSWORD) {
    console.error('ERROR: MICROSOFT_PASSWORD environment variable not set');
    console.error('Set this to the password for StanleyWarren@therxos.onmicrosoft.com');
    process.exit(1);
  }

  const daysBack = parseInt(process.env.DAYS_BACK || '3', 10);
  console.log(`Looking back ${daysBack} days for emails`);

  try {
    const result = await scrapeOutcomesEmails({
      pharmacyId: ARACOMA_PHARMACY_ID,
      daysBack
    });

    console.log('\n' + '='.repeat(60));
    console.log('RESULTS:');
    console.log('='.repeat(60));
    console.log('Emails processed:', result.emailsProcessed);
    console.log('Attachments downloaded:', result.attachmentsDownloaded);
    console.log('Records ingested:', result.recordsIngested);
    console.log('Opportunities completed:', result.opportunitiesCompleted);
    console.log('New opportunities found:', result.newOpportunitiesFound);

    if (result.errors.length > 0) {
      console.log('\nErrors:');
      result.errors.forEach((e, i) => console.log(`  ${i + 1}. ${JSON.stringify(e)}`));
    }

    console.log('\nCompleted at:', new Date().toISOString());
    console.log('='.repeat(60));

  } catch (error) {
    console.error('FATAL ERROR:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Close database connection
    await db.end();
  }
}

main();
