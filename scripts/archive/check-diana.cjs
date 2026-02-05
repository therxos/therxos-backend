const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

    // Find Diana prescribers
    const diana = await pool.query(`
      SELECT prescriber_name, prescriber_npi, COUNT(*) as rx_count
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND prescriber_name ILIKE '%diana%'
      GROUP BY prescriber_name, prescriber_npi
      ORDER BY rx_count DESC
    `, [heightsId]);

    console.log('Diana prescribers at Heights:');
    diana.rows.forEach(r => {
      console.log(`  ${r.prescriber_name} - NPI: ${r.prescriber_npi || 'NULL'} (${r.rx_count} Rxs)`);
    });

    // Show overall NPI stats
    const stats = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(prescriber_npi) as has_npi,
        COUNT(DISTINCT prescriber_name) as unique_prescribers,
        COUNT(DISTINCT CASE WHEN prescriber_npi IS NOT NULL THEN prescriber_name END) as prescribers_with_npi
      FROM prescriptions
      WHERE pharmacy_id = $1
    `, [heightsId]);

    console.log('\nHeights NPI stats:');
    console.log(stats.rows[0]);

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
