const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

    // Check what's in raw_data for Heights
    const sample = await pool.query(`
      SELECT
        prescriber_name,
        prescriber_npi,
        raw_data
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND prescriber_npi IS NULL
      LIMIT 3
    `, [heightsId]);

    console.log('Sample Heights prescriptions with NULL NPI:');
    sample.rows.forEach((r, i) => {
      console.log(`\n--- Rx ${i+1} ---`);
      console.log('prescriber_name:', r.prescriber_name);
      console.log('raw_data keys:', Object.keys(r.raw_data || {}));
      // Show NPI-related keys
      const rd = r.raw_data || {};
      Object.keys(rd).filter(k => k.toLowerCase().includes('npi') || k.toLowerCase().includes('pres')).forEach(k => {
        console.log(`  ${k}: ${rd[k]}`);
      });
    });

    // Count how many have raw NPI
    const counts = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(prescriber_npi) as has_npi,
        COUNT(raw_data->>'PresNPI') as has_raw_presnpi,
        COUNT(raw_data->>'Prescriber NPI') as has_raw_prescriber_npi
      FROM prescriptions
      WHERE pharmacy_id = $1
    `, [heightsId]);

    console.log('\n\nHeights NPI counts:');
    console.log(counts.rows[0]);

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
