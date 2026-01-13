import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Get Bravo's pharmacy ID
  const pharmacy = await pool.query("SELECT pharmacy_id, pharmacy_name FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%'");
  console.log('Pharmacy:', pharmacy.rows[0]);

  const pharmacyId = pharmacy.rows[0]?.pharmacy_id;
  if (!pharmacyId) {
    console.log('Bravo pharmacy not found');
    await pool.end();
    return;
  }

  // Current status breakdown
  const stats = await pool.query(`
    SELECT status, COUNT(*) as count, SUM(potential_margin_gain) as total_value
    FROM opportunities
    WHERE pharmacy_id = $1
    GROUP BY status
    ORDER BY count DESC
  `, [pharmacyId]);

  console.log('\nCurrent Status Breakdown:');
  stats.rows.forEach(r => {
    const val = parseFloat(r.total_value || 0).toFixed(2);
    console.log(`  ${r.status}: ${r.count} (Value: $${val})`);
  });

  // Total
  const total = await pool.query('SELECT COUNT(*) as total FROM opportunities WHERE pharmacy_id = $1', [pharmacyId]);
  console.log(`\nTotal opportunities: ${total.rows[0].total}`);

  // Check actioned_at and reviewed_at to understand what was touched
  const actioned = await pool.query(`
    SELECT COUNT(*) as count
    FROM opportunities
    WHERE pharmacy_id = $1 AND actioned_at IS NOT NULL
  `, [pharmacyId]);
  console.log(`\nWith actioned_at set: ${actioned.rows[0].count}`);

  const reviewed = await pool.query(`
    SELECT COUNT(*) as count
    FROM opportunities
    WHERE pharmacy_id = $1 AND reviewed_at IS NOT NULL
  `, [pharmacyId]);
  console.log(`With reviewed_at set: ${reviewed.rows[0].count}`);

  await pool.end();
}

check().catch(console.error);
