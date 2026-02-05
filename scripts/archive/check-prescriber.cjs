const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

    // Find patient ROL,INE with DOB 04/22/1955
    const patient = await pool.query(`
      SELECT pt.patient_id, pt.first_name, pt.last_name, pt.date_of_birth
      FROM patients pt
      WHERE pt.pharmacy_id = $1
        AND (pt.date_of_birth = '1955-04-22' OR pt.date_of_birth::text LIKE '1955-04-22%')
      LIMIT 5
    `, [heightsId]);

    console.log('Matching patients:');
    patient.rows.forEach(p => {
      console.log(`  ${p.first_name} ${p.last_name} - DOB: ${p.date_of_birth}`);
    });

    if (patient.rows.length > 0) {
      // Get prescriptions and prescriber info for this patient
      const rxs = await pool.query(`
        SELECT pr.drug_name, pr.prescriber_name, pr.prescriber_npi,
               pr.raw_data->>'PresNPI' as raw_pres_npi,
               pr.raw_data->>'PresDEA' as raw_pres_dea,
               pr.raw_data->>'PresName' as raw_pres_name
        FROM prescriptions pr
        WHERE pr.patient_id = $1
        ORDER BY pr.dispensed_date DESC
        LIMIT 5
      `, [patient.rows[0].patient_id]);

      console.log('\nRecent prescriptions:');
      rxs.rows.forEach(r => {
        console.log(`  Drug: ${r.drug_name}`);
        console.log(`    Prescriber: ${r.prescriber_name}`);
        console.log(`    NPI: ${r.prescriber_npi}`);
        console.log(`    Raw NPI: ${r.raw_pres_npi}`);
        console.log(`    Raw DEA: ${r.raw_pres_dea}`);
        console.log('');
      });

      // Get opportunities for this patient
      const opps = await pool.query(`
        SELECT o.opportunity_id, o.current_drug_name, o.recommended_drug_name,
               o.prescriber_name, o.prescriber_npi, o.status
        FROM opportunities o
        WHERE o.patient_id = $1
        LIMIT 5
      `, [patient.rows[0].patient_id]);

      console.log('Opportunities:');
      opps.rows.forEach(o => {
        console.log(`  ${o.current_drug_name} -> ${o.recommended_drug_name}`);
        console.log(`    Prescriber: ${o.prescriber_name}, NPI: ${o.prescriber_npi}`);
        console.log(`    Status: ${o.status}`);
        console.log('');
      });
    }

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
