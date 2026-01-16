import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function updatePrescribers() {
  console.log('Updating opportunities with prescriber names...\n');

  // For each opportunity, find the matching prescription and get the prescriber
  const result = await pool.query(`
    UPDATE opportunities o
    SET prescriber_name = (
      SELECT p.prescriber_name
      FROM prescriptions p
      WHERE p.patient_id = o.patient_id
        AND p.pharmacy_id = o.pharmacy_id
        AND UPPER(TRIM(p.drug_name)) = UPPER(TRIM(o.current_drug_name))
      ORDER BY p.dispensed_date DESC
      LIMIT 1
    )
    WHERE o.pharmacy_id = $1
      AND o.prescriber_name IS NULL
    RETURNING o.opportunity_id
  `, [pharmacyId]);

  console.log(`Updated ${result.rowCount} opportunities with prescriber names`);

  // Check results
  const check = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(prescriber_name) as with_prescriber
    FROM opportunities WHERE pharmacy_id = $1
  `, [pharmacyId]);

  console.log(`\nResults: ${check.rows[0].with_prescriber} of ${check.rows[0].total} opportunities now have prescribers`);

  // Show top prescribers in opportunities
  const topPrescribers = await pool.query(`
    SELECT prescriber_name, COUNT(*) as opp_count, SUM(annual_margin_gain) as total_annual
    FROM opportunities
    WHERE pharmacy_id = $1 AND prescriber_name IS NOT NULL
    GROUP BY prescriber_name
    ORDER BY SUM(annual_margin_gain) DESC
    LIMIT 15
  `, [pharmacyId]);

  console.log('\nTop prescribers by opportunity value:');
  console.log('Prescriber'.padEnd(35) + ' | Opps  | Annual $');
  console.log('-'.repeat(60));
  for (const r of topPrescribers.rows) {
    console.log(
      (r.prescriber_name || '').substring(0, 33).padEnd(35),
      '|', String(r.opp_count).padStart(5),
      '|', '$' + Number(r.total_annual).toLocaleString()
    );
  }

  await pool.end();
}

updatePrescribers().catch(console.error);
