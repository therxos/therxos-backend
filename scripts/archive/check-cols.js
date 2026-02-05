import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function check() {
  // Find all raw_data keys that mention profit, price, cost, paid, margin, reimb
  const r1 = await pool.query(`
    SELECT DISTINCT key
    FROM prescriptions, jsonb_each_text(raw_data)
    WHERE LOWER(key) ~ '(profit|price|cost|paid|margin|reimb|adj|net|gross|total|amount|fee|charge)'
    ORDER BY key
  `);
  console.log('=== raw_data keys matching profit/price/cost patterns ===');
  r1.rows.forEach(r => console.log('  ' + r.key));

  // Now get sample values for each key from a pen needle claim
  const r2 = await pool.query(`
    SELECT raw_data
    FROM prescriptions
    WHERE LOWER(drug_name) LIKE '%pen needle%'
      AND insurance_bin = '610494'
      AND dispensed_date >= '2025-09-01'
    LIMIT 1
  `);
  console.log('\n=== Sample ACUMI pen needle raw_data (full) ===');
  if (r2.rows[0]?.raw_data) {
    Object.entries(r2.rows[0].raw_data).forEach(([k, v]) => {
      if (v !== null && v !== '') console.log('  ' + k.padEnd(40) + String(v));
    });
  }

  // Check a 003858 claim raw_data
  const r3 = await pool.query(`
    SELECT raw_data
    FROM prescriptions
    WHERE LOWER(drug_name) LIKE '%pen needle%'
      AND insurance_bin = '003858'
      AND dispensed_date >= '2025-09-01'
    LIMIT 1
  `);
  console.log('\n=== Sample 003858 pen needle raw_data (full) ===');
  if (r3.rows[0]?.raw_data) {
    Object.entries(r3.rows[0].raw_data).forEach(([k, v]) => {
      if (v !== null && v !== '') console.log('  ' + k.padEnd(40) + String(v));
    });
  }

  // Check a 004336 claim raw_data with price
  const r4 = await pool.query(`
    SELECT raw_data
    FROM prescriptions
    WHERE LOWER(drug_name) LIKE '%pen needle%'
      AND insurance_bin = '004336'
      AND dispensed_date >= '2025-09-01'
      AND raw_data->>'Price' IS NOT NULL
    LIMIT 1
  `);
  console.log('\n=== Sample 004336 pen needle raw_data with Price ===');
  if (r4.rows[0]?.raw_data) {
    Object.entries(r4.rows[0].raw_data).forEach(([k, v]) => {
      if (v !== null && v !== '') console.log('  ' + k.padEnd(40) + String(v));
    });
  }

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
