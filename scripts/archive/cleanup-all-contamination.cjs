const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Pharmacies to clean (NOT Noor - that's the source)
const pharmaciesToClean = [
  { id: '5b77e7f0-66c0-4f1b-b307-deeed69354c9', name: 'Aracoma Drug' },
  { id: '0e3014d3-0069-4526-9b9b-0d567882582b', name: 'Medicine Shoppe 1248' },
  { id: 'cee24eeb-d2b0-46c6-a57d-8f3b33fced19', name: 'Orlando Pharmacy' },
  { id: 'f0bd945a-836d-422b-8e58-ceb4dda0a12a', name: 'Parkway Pharmacy' },
];

const noorId = 'a68e2910-9e73-4cc8-a345-6e9cc111b7ec';

(async () => {
  const client = await pool.connect();

  for (const pharmacy of pharmaciesToClean) {
    console.log(`\n=== Cleaning ${pharmacy.name} ===`);
    try {
      await client.query('BEGIN');

      // Step 1: Get contaminated patient IDs
      const contaminatedPatients = await client.query(`
        SELECT DISTINCT patient_id FROM prescriptions
        WHERE pharmacy_id = $1 AND source_file ILIKE '%noor%'
      `, [pharmacy.id]);
      const patientIds = contaminatedPatients.rows.map(r => r.patient_id);
      console.log('Contaminated patients:', patientIds.length);

      if (patientIds.length === 0) {
        await client.query('COMMIT');
        console.log('No contamination found');
        continue;
      }

      // Step 2: Transfer actioned opportunities to Noor
      const transferred = await client.query(`
        UPDATE opportunities
        SET pharmacy_id = $1,
            staff_notes = COALESCE(staff_notes, '') || E'\n[TRANSFERRED: Originally imported to ${pharmacy.name} in error]'
        WHERE pharmacy_id = $2
          AND patient_id = ANY($3)
          AND status != 'Not Submitted'
        RETURNING opportunity_id, status
      `, [noorId, pharmacy.id, patientIds]);
      console.log('Transferred actioned opps to Noor:', transferred.rowCount);

      // Step 3: Delete non-actioned opportunities
      const deletedOpps = await client.query(`
        DELETE FROM opportunities
        WHERE pharmacy_id = $1
          AND patient_id = ANY($2)
          AND status = 'Not Submitted'
        RETURNING opportunity_id
      `, [pharmacy.id, patientIds]);
      console.log('Deleted non-actioned opps:', deletedOpps.rowCount);

      // Step 4: Delete contaminated prescriptions
      const deletedRx = await client.query(`
        DELETE FROM prescriptions
        WHERE pharmacy_id = $1 AND source_file ILIKE '%noor%'
        RETURNING prescription_id
      `, [pharmacy.id]);
      console.log('Deleted contaminated Rx:', deletedRx.rowCount);

      // Step 5: Delete patients that now have no prescriptions AND no opportunities
      const deletedPatients = await client.query(`
        DELETE FROM patients
        WHERE pharmacy_id = $1
          AND patient_id = ANY($2)
          AND patient_id NOT IN (SELECT DISTINCT patient_id FROM prescriptions WHERE pharmacy_id = $1)
          AND patient_id NOT IN (SELECT DISTINCT patient_id FROM opportunities WHERE pharmacy_id = $1)
        RETURNING patient_id
      `, [pharmacy.id, patientIds]);
      console.log('Deleted orphaned patients:', deletedPatients.rowCount);

      await client.query('COMMIT');
      console.log(`✅ ${pharmacy.name} cleaned`);

    } catch (e) {
      await client.query('ROLLBACK');
      console.error(`Error cleaning ${pharmacy.name}:`, e.message);
    }
  }

  client.release();
  await pool.end();
  console.log('\n=== ALL CLEANUP COMPLETE ===');
})();
