const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';
    const noorId = 'a68e2910-9e73-4cc8-a345-6e9cc111b7ec';

    // Step 1: Get contaminated patient IDs
    const contaminatedPatients = await client.query(`
      SELECT DISTINCT patient_id FROM prescriptions
      WHERE pharmacy_id = $1 AND source_file ILIKE '%noor%'
    `, [heightsId]);
    const patientIds = contaminatedPatients.rows.map(r => r.patient_id);
    console.log('Contaminated patients:', patientIds.length);

    // Step 2: Transfer actioned opportunities to Noor
    const transferred = await client.query(`
      UPDATE opportunities
      SET pharmacy_id = $1,
          staff_notes = COALESCE(staff_notes, '') || E'\n[TRANSFERRED: Originally imported to Heights Chemist in error on 2026-02-02]'
      WHERE pharmacy_id = $2
        AND patient_id = ANY($3)
        AND status != 'Not Submitted'
      RETURNING opportunity_id, status
    `, [noorId, heightsId, patientIds]);
    console.log('Transferred actioned opps to Noor:', transferred.rowCount);

    // Step 3: Delete non-actioned opportunities
    const deletedOpps = await client.query(`
      DELETE FROM opportunities
      WHERE pharmacy_id = $1
        AND patient_id = ANY($2)
        AND status = 'Not Submitted'
      RETURNING opportunity_id
    `, [heightsId, patientIds]);
    console.log('Deleted non-actioned opps:', deletedOpps.rowCount);

    // Step 4: Delete contaminated prescriptions
    const deletedRx = await client.query(`
      DELETE FROM prescriptions
      WHERE pharmacy_id = $1 AND source_file ILIKE '%noor%'
      RETURNING prescription_id
    `, [heightsId]);
    console.log('Deleted contaminated Rx:', deletedRx.rowCount);

    // Step 5: Delete patients that now have no prescriptions AND no opportunities in Heights
    const deletedPatients = await client.query(`
      DELETE FROM patients
      WHERE pharmacy_id = $1
        AND patient_id = ANY($2)
        AND patient_id NOT IN (SELECT DISTINCT patient_id FROM prescriptions WHERE pharmacy_id = $1)
        AND patient_id NOT IN (SELECT DISTINCT patient_id FROM opportunities WHERE pharmacy_id = $1)
      RETURNING patient_id
    `, [heightsId, patientIds]);
    console.log('Deleted orphaned patients:', deletedPatients.rowCount);

    await client.query('COMMIT');
    console.log('\n✅ Cleanup complete - Noor data removed from Heights Chemist');

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error:', e.message);
    console.error(e.stack);
  } finally {
    client.release();
    await pool.end();
  }
})();
