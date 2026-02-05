const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Search for Krymskaya across ALL pharmacies
    const prescribers = await pool.query(`
      SELECT DISTINCT
        prescriber_name,
        prescriber_npi,
        p.pharmacy_name,
        COUNT(*) as rx_count
      FROM prescriptions pr
      JOIN pharmacies p ON p.pharmacy_id = pr.pharmacy_id
      WHERE prescriber_name ILIKE '%krymskaya%'
      GROUP BY prescriber_name, prescriber_npi, p.pharmacy_name
      ORDER BY rx_count DESC
    `);

    console.log('Krymskaya prescriber records across all pharmacies:');
    prescribers.rows.forEach(r => {
      console.log(`  ${r.pharmacy_name}: "${r.prescriber_name}" NPI: ${r.prescriber_npi || 'NULL'} (${r.rx_count} Rxs)`);
    });

    // Also check NPI registry lookup
    const npiLookup = await pool.query(`
      SELECT * FROM prescriber_npi_cache
      WHERE prescriber_name ILIKE '%krymskaya%'
      LIMIT 5
    `);

    if (npiLookup.rows.length > 0) {
      console.log('\nNPI Cache entries:');
      npiLookup.rows.forEach(r => {
        console.log(`  ${r.prescriber_name}: ${r.npi}`);
      });
    }

    // Check if we have opportunities for Krymskaya at Heights
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';
    const opps = await pool.query(`
      SELECT o.opportunity_id, o.current_drug_name, o.recommended_drug_name,
             pt.first_name, pt.last_name, o.status,
             pr.prescriber_name, pr.prescriber_npi
      FROM opportunities o
      JOIN patients pt ON pt.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.pharmacy_id = $1
        AND pr.prescriber_name ILIKE '%krymskaya%'
      LIMIT 10
    `, [heightsId]);

    console.log('\nHeights Chemist opportunities for Krymskaya:');
    opps.rows.forEach(o => {
      console.log(`  ${o.first_name} ${o.last_name}: ${o.current_drug_name} -> ${o.recommended_drug_name}`);
      console.log(`    Prescriber NPI: ${o.prescriber_npi || 'NULL'}, Status: ${o.status}`);
    });

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
