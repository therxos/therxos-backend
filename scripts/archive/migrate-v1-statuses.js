// migrate-v1-statuses.js
// Migrates opportunity statuses from V1 CSV to V2 database
// Usage: node migrate-v1-statuses.js <email> <v1-csv-path>

import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// V1 and V2 statuses now match exactly:
// Not Submitted, Submitted, Approved, Completed, Denied, Didn't Work
const VALID_STATUSES = ['Not Submitted', 'Submitted', 'Approved', 'Completed', 'Denied', "Didn't Work", "Didn't work"];

async function migrate(email, csvPath) {
  console.log(`\n🔄 Migrating V1 statuses for: ${email}`);
  console.log(`📄 CSV: ${csvPath}\n`);

  // Get pharmacy ID
  const userResult = await pool.query(
    'SELECT pharmacy_id FROM users WHERE email = $1',
    [email]
  );
  
  if (userResult.rows.length === 0) {
    console.error('❌ User not found:', email);
    process.exit(1);
  }
  
  const pharmacyId = userResult.rows[0].pharmacy_id;
  console.log(`📍 Pharmacy ID: ${pharmacyId}`);

  // Read CSV
  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  console.log(`📊 Found ${records.length} opportunities in V1 CSV\n`);

  // Get all V2 opportunities for this pharmacy
  const v2Opps = await pool.query(`
    SELECT o.opportunity_id, o.recommended_drug_name, o.status,
           p.first_name, p.last_name, p.date_of_birth
    FROM opportunities o
    JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.pharmacy_id = $1
  `, [pharmacyId]);

  console.log(`📊 Found ${v2Opps.rows.length} opportunities in V2 database\n`);

  // Build lookup map for V2 opportunities
  // Key: patient_masked + recommended_drug (normalized)
  const v2Map = new Map();
  for (const opp of v2Opps.rows) {
    const firstName = (opp.first_name || '').toUpperCase().slice(0, 3);
    const lastName = (opp.last_name || '').toUpperCase().slice(0, 3);
    const patientMasked = `${lastName},${firstName}`;
    const recDrug = (opp.recommended_drug_name || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    const key = `${patientMasked}|${recDrug}`;
    
    if (!v2Map.has(key)) {
      v2Map.set(key, []);
    }
    v2Map.get(key).push(opp);
  }

  let matched = 0;
  let updated = 0;
  let skipped = 0;
  let notFound = 0;

  for (const row of records) {
    const v1Status = (row.Status || '').trim();
    
    // Skip if status is blank or "Not Submitted" - already default in V2
    if (!v1Status || v1Status === 'Not Submitted') {
      skipped++;
      continue;
    }
    
    // Normalize "Didn't work" to "Didn't Work"
    const normalizedStatus = v1Status === "Didn't work" ? "Didn't Work" : v1Status;
    
    // Validate status
    if (!VALID_STATUSES.includes(v1Status)) {
      console.log(`  ⚠️  Unknown status: "${v1Status}"`);
      skipped++;
      continue;
    }

    // Build match key
    const patientMasked = (row.Patient_Masked || '').toUpperCase().trim();
    const recDrug = (row.Recommended_Drug || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    const key = `${patientMasked}|${recDrug}`;

    const matches = v2Map.get(key);
    
    if (!matches || matches.length === 0) {
      console.log(`  ⚠️  Not found: ${patientMasked} | ${row.Recommended_Drug?.slice(0, 30)}`);
      notFound++;
      continue;
    }

    matched++;

    // Update V2 opportunities with V1 status (direct copy since they match now)
    for (const opp of matches) {
      if (opp.status === 'Not Submitted') {
        await pool.query(
          'UPDATE opportunities SET status = $1, updated_at = NOW() WHERE opportunity_id = $2',
          [normalizedStatus, opp.opportunity_id]
        );
        console.log(`  ✅ Updated: ${patientMasked} → ${normalizedStatus}`);
        updated++;
      }
    }
  }

  console.log(`\n📈 Migration Summary:`);
  console.log(`   Total V1 records: ${records.length}`);
  console.log(`   Matched: ${matched}`);
  console.log(`   Updated: ${updated}`);
  console.log(`   Skipped (already new): ${skipped}`);
  console.log(`   Not found in V2: ${notFound}`);

  await pool.end();
  console.log('\n✅ Migration complete!');
}

// Main
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('Usage: node migrate-v1-statuses.js <email> <v1-csv-path>');
  console.log('Example: node migrate-v1-statuses.js contact@mybravorx.com ./Bravo_v1_opportunities.csv');
  process.exit(1);
}

migrate(args[0], args[1]).catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
