import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function fix() {
  // Fix: annual_margin_gain should be potential * 12
  // Only fix ones where they're equal (the ones I just created)
  const result = await pool.query(`
    UPDATE opportunities
    SET annual_margin_gain = potential_margin_gain * 12
    WHERE pharmacy_id = $1
      AND annual_margin_gain = potential_margin_gain
    RETURNING opportunity_id
  `, [pharmacyId]);

  console.log('Fixed', result.rowCount, 'opportunities');

  // Verify new totals
  const totals = await pool.query(`
    SELECT
      COUNT(*) as cnt,
      SUM(potential_margin_gain) as monthly,
      SUM(annual_margin_gain) as annual
    FROM opportunities WHERE pharmacy_id = $1
  `, [pharmacyId]);

  console.log('\nNew totals:');
  console.log('  Opportunities:', totals.rows[0].cnt);
  console.log('  Monthly potential:', '$' + Number(totals.rows[0].monthly).toLocaleString());
  console.log('  Annual potential:', '$' + Number(totals.rows[0].annual).toLocaleString());

  await pool.end();
}

fix().catch(console.error);
