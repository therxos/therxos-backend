import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Check all variants with NDC and qty
  const r = await pool.query(`
    SELECT drug_name, ndc,
           AVG(quantity_dispensed) as avg_qty,
           COUNT(*) as cnt
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%DORZOLAMIDE%' AND UPPER(drug_name) LIKE '%TIMOLOL%'
    GROUP BY drug_name, ndc
    ORDER BY cnt DESC
  `);
  console.log('Dorzolamide-Timolol variants:');
  r.rows.forEach(row => {
    console.log(`  "${row.drug_name}" | NDC: ${row.ndc || 'none'} | avg_qty: ${parseFloat(row.avg_qty).toFixed(1)} | cnt: ${row.cnt}`);
  });

  // Check a sample raw_data for unit info
  const sample = await pool.query(`
    SELECT drug_name, ndc, quantity_dispensed, days_supply, raw_data
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%DORZOLAMIDE%' AND UPPER(drug_name) LIKE '%TIMOLOL%'
    AND raw_data IS NOT NULL
    LIMIT 5
  `);
  console.log('\nSample raw_data fields:');
  sample.rows.forEach((row, i) => {
    console.log(`\n  Sample ${i+1}: "${row.drug_name}" NDC:${row.ndc} qty:${row.quantity_dispensed} days:${row.days_supply}`);
    if (row.raw_data) {
      const keys = Object.keys(row.raw_data);
      console.log(`  Keys: ${keys.join(', ')}`);
      // Look for unit-related fields
      for (const k of keys) {
        if (k.toLowerCase().includes('unit') || k.toLowerCase().includes('uom') || k.toLowerCase().includes('metric') || k.toLowerCase().includes('form') || k.toLowerCase().includes('strength')) {
          console.log(`  ${k}: ${row.raw_data[k]}`);
        }
      }
    }
  });

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
