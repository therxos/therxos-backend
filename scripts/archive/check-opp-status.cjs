const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

    // Check recent Krymskaya opportunities
    const opps = await pool.query(`
      SELECT o.opportunity_id, o.status, o.current_drug_name, o.recommended_drug_name,
             pt.first_name, pt.last_name,
             pr.prescriber_name
      FROM opportunities o
      JOIN patients pt ON pt.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.pharmacy_id = $1
        AND pr.prescriber_name ILIKE '%krymskaya%'
      LIMIT 5
    `, [heightsId]);

    console.log('Krymskaya opportunities at Heights:');
    opps.rows.forEach(o => {
      console.log('---');
      console.log('Patient:', o.first_name, o.last_name);
      console.log('Status:', o.status);
      console.log('Current:', o.current_drug_name);
      console.log('Recommended:', o.recommended_drug_name);
    });

    // Check for any data quality issues
    if (opps.rows.length > 0) {
      const dqi = await pool.query(`
        SELECT COUNT(*) as count
        FROM data_quality_issues
        WHERE opportunity_id = $1 AND status = 'pending'
      `, [opps.rows[0].opportunity_id]);
      console.log('\nData quality issues for first opp:', dqi.rows[0].count);
    }

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
