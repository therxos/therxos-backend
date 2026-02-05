const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

    // Backfill from raw_data->>'PresNPI' where it exists
    const backfillResult = await pool.query(`
      UPDATE prescriptions
      SET prescriber_npi = raw_data->>'PresNPI'
      WHERE pharmacy_id = $1
        AND (prescriber_npi IS NULL OR prescriber_npi = '')
        AND raw_data->>'PresNPI' IS NOT NULL
        AND raw_data->>'PresNPI' != ''
      RETURNING prescription_id, prescriber_name, prescriber_npi
    `, [heightsId]);

    console.log(`Backfilled ${backfillResult.rows.length} prescriptions with NPI from raw_data`);
    if (backfillResult.rows.length > 0) {
      console.log('\nSample updated:');
      backfillResult.rows.slice(0, 5).forEach(r => {
        console.log(`  ${r.prescriber_name}: ${r.prescriber_npi}`);
      });
    }

    // Show stats after
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(prescriber_npi) as has_npi,
        COUNT(DISTINCT prescriber_name) as unique_prescribers,
        COUNT(DISTINCT prescriber_npi) as unique_npis
      FROM prescriptions
      WHERE pharmacy_id = $1
    `, [heightsId]);

    console.log('\n\nHeights NPI stats after backfill:');
    console.log(stats.rows[0]);

    // Show prescribers still missing NPI
    const missing = await pool.query(`
      SELECT prescriber_name, COUNT(*) as rx_count
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND (prescriber_npi IS NULL OR prescriber_npi = '')
      GROUP BY prescriber_name
      ORDER BY rx_count DESC
      LIMIT 10
    `, [heightsId]);

    console.log('\n\nTop prescribers still missing NPI:');
    missing.rows.forEach(r => {
      console.log(`  ${r.prescriber_name}: ${r.rx_count} Rxs`);
    });

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
