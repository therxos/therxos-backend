/**
 * Import NADAC (National Average Drug Acquisition Cost) data from CMS CSV
 * Source: https://download.medicaid.gov/data/nadac-national-average-drug-acquisition-cost-12-31-2025.csv
 *
 * Loads the most recent NADAC per-unit price for each NDC into the nadac_pricing table.
 */
import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import db from './src/database/index.js';

const CSV_PATH = './nadac-2025.csv';

async function importNadac() {
  console.log('=== NADAC DATA IMPORT ===\n');

  // Phase 1: Read CSV and keep only latest rate per NDC
  console.log('Reading CSV and deduplicating by NDC (keeping latest effective date)...');

  const fileStream = fs.createReadStream(CSV_PATH);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const nadacByNdc = new Map(); // ndc -> { nadac_per_unit, pricing_unit, effective_date, description, classification }
  let lineNum = 0;
  let skipped = 0;

  for await (const line of rl) {
    lineNum++;
    if (lineNum === 1) continue; // Skip header

    // Parse CSV with quoted fields
    const fields = parseCSVLine(line);
    if (fields.length < 9) {
      skipped++;
      continue;
    }

    const [description, ndc, nadacPerUnit, effectiveDate, pricingUnit, _pharmType, _otc, _explCode, classification] = fields;

    if (!ndc || !nadacPerUnit || nadacPerUnit === '0' || nadacPerUnit === '0.00000') {
      skipped++;
      continue;
    }

    // Parse the effective date (MM/DD/YYYY)
    const dateParts = effectiveDate.split('/');
    if (dateParts.length !== 3) {
      skipped++;
      continue;
    }
    const effDate = new Date(`${dateParts[2]}-${dateParts[0].padStart(2, '0')}-${dateParts[1].padStart(2, '0')}`);

    // Clean NDC - ensure 11 digits
    const cleanNdc = ndc.replace(/[^0-9]/g, '').padStart(11, '0');

    const existing = nadacByNdc.get(cleanNdc);
    if (!existing || effDate > existing.effDateObj) {
      nadacByNdc.set(cleanNdc, {
        ndc: cleanNdc,
        nadac_per_unit: parseFloat(nadacPerUnit),
        pricing_unit: (pricingUnit || 'EA').trim().toUpperCase(),
        effective_date: `${dateParts[2]}-${dateParts[0].padStart(2, '0')}-${dateParts[1].padStart(2, '0')}`,
        effDateObj: effDate,
        description: description?.substring(0, 100),
        classification: (classification || '').trim().substring(0, 5) // G=Generic, B=Brand
      });
    }
  }

  console.log(`CSV read complete: ${lineNum - 1} data rows, ${skipped} skipped`);
  console.log(`Unique NDCs with latest rates: ${nadacByNdc.size}\n`);

  // Phase 2: Insert into nadac_pricing
  console.log('Inserting into nadac_pricing table...');

  // Ensure table has required columns (add missing ones)
  try {
    await db.query('SELECT 1 FROM nadac_pricing LIMIT 1');
    console.log('Table nadac_pricing exists.');
    // Add missing columns if needed
    try { await db.query('ALTER TABLE nadac_pricing ADD COLUMN IF NOT EXISTS classification VARCHAR(5)'); } catch (e) { /* column may already exist */ }
    try { await db.query('ALTER TABLE nadac_pricing ALTER COLUMN classification TYPE VARCHAR(5)'); } catch (e) { /* ignore */ }
    try { await db.query('ALTER TABLE nadac_pricing ADD COLUMN IF NOT EXISTS description VARCHAR(100)'); } catch (e) { /* column may already exist */ }
    console.log('Schema updated.\n');
  } catch (e) {
    console.log('Table nadac_pricing does not exist. Creating...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS nadac_pricing (
        nadac_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ndc VARCHAR(11) NOT NULL,
        nadac_per_unit DECIMAL(10,4) NOT NULL,
        pricing_unit VARCHAR(10) DEFAULT 'EA',
        effective_date DATE NOT NULL,
        classification VARCHAR(2),
        description VARCHAR(100),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(ndc, effective_date)
      )
    `);
    await db.query('CREATE INDEX IF NOT EXISTS idx_nadac_ndc ON nadac_pricing(ndc)');
    await db.query('CREATE INDEX IF NOT EXISTS idx_nadac_date ON nadac_pricing(effective_date DESC)');
    console.log('Table created.\n');
  }

  // Clear existing data and bulk insert
  const existingCount = await db.query('SELECT COUNT(*) FROM nadac_pricing');
  console.log(`Existing rows in nadac_pricing: ${existingCount.rows[0].count}`);

  // Use batch insert for performance
  let inserted = 0;
  let errors = 0;
  const entries = Array.from(nadacByNdc.values());
  const BATCH_SIZE = 500;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    // Build multi-row INSERT
    const values = [];
    const placeholders = [];
    let paramIdx = 1;

    for (const entry of batch) {
      placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, $${paramIdx + 5})`);
      values.push(
        entry.ndc,
        entry.nadac_per_unit,
        entry.pricing_unit,
        entry.effective_date,
        entry.classification || null,
        entry.description || null
      );
      paramIdx += 6;
    }

    try {
      await db.query(`
        INSERT INTO nadac_pricing (ndc, nadac_per_unit, pricing_unit, effective_date, classification, description)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (ndc, effective_date) DO UPDATE SET
          nadac_per_unit = EXCLUDED.nadac_per_unit,
          pricing_unit = EXCLUDED.pricing_unit,
          classification = EXCLUDED.classification,
          description = EXCLUDED.description
      `, values);
      inserted += batch.length;
    } catch (err) {
      // Fall back to individual inserts on batch failure
      for (const entry of batch) {
        try {
          await db.query(`
            INSERT INTO nadac_pricing (ndc, nadac_per_unit, pricing_unit, effective_date, classification, description)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (ndc, effective_date) DO UPDATE SET
              nadac_per_unit = $2,
              pricing_unit = $3,
              classification = $5,
              description = $6
          `, [entry.ndc, entry.nadac_per_unit, entry.pricing_unit, entry.effective_date, entry.classification, entry.description]);
          inserted++;
        } catch (innerErr) {
          errors++;
          if (errors <= 5) console.error(`  Error: ${entry.ndc} - ${innerErr.message}`);
        }
      }
    }

    if ((i + BATCH_SIZE) % 10000 === 0 || i + BATCH_SIZE >= entries.length) {
      console.log(`  Progress: ${Math.min(i + BATCH_SIZE, entries.length)}/${entries.length} (${inserted} inserted, ${errors} errors)`);
    }
  }

  console.log(`\n=== IMPORT COMPLETE ===`);
  console.log(`Inserted/updated: ${inserted}`);
  console.log(`Errors: ${errors}`);

  // Phase 3: Verify with some sample lookups
  console.log('\n--- Sample NADAC Lookups ---');
  const samples = [
    { name: 'Pitavastatin 2mg', pattern: '%PITAVASTATIN%2%MG%' },
    { name: 'Amlodipine 10mg', pattern: '%AMLODIPINE%10%MG%' },
    { name: 'Dexlansoprazole 30mg', pattern: '%DEXLANSOPRAZOLE%30%MG%' },
    { name: 'Losartan 50mg', pattern: '%LOSARTAN%50%MG%' },
    { name: 'Freestyle Libre', pattern: '%FREESTYLE%' },
    { name: 'Lancets', pattern: '%LANCET%' },
  ];

  for (const s of samples) {
    const result = await db.query(`
      SELECT ndc, nadac_per_unit, pricing_unit, classification, description
      FROM nadac_pricing
      WHERE UPPER(description) LIKE $1
      ORDER BY nadac_per_unit DESC
      LIMIT 3
    `, [s.pattern]);
    if (result.rows.length > 0) {
      console.log(`\n${s.name}:`);
      for (const r of result.rows) {
        console.log(`  NDC ${r.ndc}: $${parseFloat(r.nadac_per_unit).toFixed(4)}/${r.pricing_unit} (${r.classification === 'G' ? 'Generic' : 'Brand'}) - ${r.description}`);
      }
    } else {
      console.log(`\n${s.name}: No NADAC data found`);
    }
  }

  // Final count
  const finalCount = await db.query('SELECT COUNT(*) as total, COUNT(DISTINCT ndc) as unique_ndcs FROM nadac_pricing');
  console.log(`\nFinal table stats: ${finalCount.rows[0].total} rows, ${finalCount.rows[0].unique_ndcs} unique NDCs`);

  await db.end();
  process.exit(0);
}

// Simple CSV parser that handles quoted fields with commas
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

importNadac().catch(e => {
  console.error('Import failed:', e);
  process.exit(1);
});
