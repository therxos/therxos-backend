const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';
    const prescriberNpi = '1942323647';
    const prescriberName = 'KRYMSKAYA, MARINA';
    const faxNumber = '2124344974'; // User provided: 212-434-4974

    // 1. Save to prescriber_fax_directory
    const dirResult = await pool.query(`
      INSERT INTO prescriber_fax_directory (pharmacy_id, prescriber_npi, prescriber_name, fax_number)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (pharmacy_id, prescriber_npi)
      DO UPDATE SET fax_number = $4, prescriber_name = $3, updated_at = NOW()
      RETURNING *
    `, [heightsId, prescriberNpi, prescriberName, faxNumber]);

    console.log('Saved to prescriber_fax_directory:', dirResult.rows[0]);

    // 2. Backfill prescriber_npi on all Krymskaya prescriptions at Heights
    const rxUpdate = await pool.query(`
      UPDATE prescriptions
      SET prescriber_npi = $1
      WHERE pharmacy_id = $2
        AND prescriber_name ILIKE '%krymskaya%'
        AND (prescriber_npi IS NULL OR prescriber_npi = '')
      RETURNING prescription_id, drug_name
    `, [prescriberNpi, heightsId]);

    console.log(`\nUpdated ${rxUpdate.rows.length} prescriptions with NPI`);
    if (rxUpdate.rows.length > 0) {
      console.log('Sample:', rxUpdate.rows.slice(0, 3));
    }

    // 3. Also update opportunities that have prescriber_name matching Krymskaya
    const oppUpdate = await pool.query(`
      UPDATE opportunities o
      SET prescriber_npi = $1, prescriber_name = COALESCE(o.prescriber_name, $2)
      WHERE o.pharmacy_id = $3
        AND EXISTS (
          SELECT 1 FROM prescriptions pr
          WHERE pr.prescription_id = o.prescription_id
          AND pr.prescriber_name ILIKE '%krymskaya%'
        )
        AND (o.prescriber_npi IS NULL OR o.prescriber_npi = '')
      RETURNING opportunity_id, current_drug_name
    `, [prescriberNpi, prescriberName, heightsId]);

    console.log(`\nUpdated ${oppUpdate.rows.length} opportunities with NPI`);
    if (oppUpdate.rows.length > 0) {
      console.log('Sample:', oppUpdate.rows.slice(0, 3));
    }

    // 4. Verify
    const verify = await pool.query(`
      SELECT o.opportunity_id, o.current_drug_name, o.recommended_drug_name,
             o.prescriber_name, o.prescriber_npi, o.status
      FROM opportunities o
      JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.pharmacy_id = $1
        AND pr.prescriber_name ILIKE '%krymskaya%'
      LIMIT 5
    `, [heightsId]);

    console.log('\nKrymskaya opportunities now:');
    verify.rows.forEach(o => {
      console.log(`  ${o.current_drug_name} -> ${o.recommended_drug_name}`);
      console.log(`    NPI: ${o.prescriber_npi}, Status: ${o.status}`);
    });

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
