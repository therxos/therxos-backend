import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function updateOpportunityValues() {
  console.log('='.repeat(80));
  console.log('UPDATING OPPORTUNITY VALUES BASED ON NEW TRIGGER GP');
  console.log('='.repeat(80));

  // Get current totals
  const before = await pool.query(`
    SELECT COUNT(*) as cnt, SUM(annual_margin_gain) as total
    FROM opportunities WHERE pharmacy_id = $1
  `, [pharmacyId]);
  console.log(`\nBefore: ${before.rows[0].cnt} opportunities, $${Number(before.rows[0].total).toLocaleString()} annual`);

  // The opportunities were created with GP values as potential_margin_gain
  // and annual = potential * 12
  // But we need to recalculate based on the patient's BIN

  // For now, let's just delete and rescan since we have new GP values
  // This is cleaner than trying to match opportunities back to their BINs

  console.log('\nDeleting existing opportunities to rescan with correct values...');

  const deleted = await pool.query(`
    DELETE FROM opportunities WHERE pharmacy_id = $1 RETURNING opportunity_id
  `, [pharmacyId]);

  console.log(`Deleted ${deleted.rowCount} opportunities`);
  console.log('\nNow run the rescan to create opportunities with correct Medicaid GP values.');

  await pool.end();
}

updateOpportunityValues().catch(console.error);
