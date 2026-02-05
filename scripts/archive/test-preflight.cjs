const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Simulate the preflight check locally
async function testPreflight(pharmacyId, opportunityId) {
  try {
    console.log('Testing preflight for opportunity:', opportunityId);

    // 1. Check pharmacy
    const pharmacyResult = await pool.query(
      'SELECT settings, fax FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );
    const pharmacy = pharmacyResult.rows[0];
    console.log('1. Pharmacy found:', !!pharmacy);
    console.log('   faxEnabled:', pharmacy?.settings?.faxEnabled);

    if (!pharmacy?.settings?.faxEnabled) {
      console.log('FAILED: Fax not enabled');
      return;
    }

    // 2. Check opportunity
    const oppResult = await pool.query(`
      SELECT o.*, pr.prescriber_name, pr.prescriber_npi
      FROM opportunities o
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.opportunity_id = $1 AND o.pharmacy_id = $2
    `, [opportunityId, pharmacyId]);

    console.log('2. Opportunity found:', oppResult.rows.length > 0);
    if (oppResult.rows.length > 0) {
      const opp = oppResult.rows[0];
      console.log('   Status:', opp.status);
      console.log('   Prescriber:', opp.prescriber_name);
      console.log('   NPI:', opp.prescriber_npi);

      if (opp.status !== 'Not Submitted') {
        console.log('FAILED: Status is not "Not Submitted"');
      }
    }

    // 3. Check data quality issues
    const dqResult = await pool.query(`
      SELECT COUNT(*) as count FROM data_quality_issues
      WHERE opportunity_id = $1 AND status = 'pending'
    `, [opportunityId]);
    console.log('3. Data quality issues:', dqResult.rows[0].count);

    console.log('\nPreflight should PASS if all checks above are OK');
  } catch (e) {
    console.error('ERROR during preflight:', e.message);
  }
}

(async () => {
  const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

  // Get a sample opportunity
  const opp = await pool.query(`
    SELECT opportunity_id FROM opportunities
    WHERE pharmacy_id = $1 AND status = 'Not Submitted'
    LIMIT 1
  `, [heightsId]);

  if (opp.rows.length > 0) {
    await testPreflight(heightsId, opp.rows[0].opportunity_id);
  } else {
    console.log('No "Not Submitted" opportunities found');
  }

  await pool.end();
})();
