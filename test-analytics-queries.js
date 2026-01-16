import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8'; // Heights Chemist

async function test() {
  // Test prescriber stats query
  const topByValue = await pool.query(`
    SELECT
      COALESCE(o.prescriber_name, 'Unknown') as prescriber_name,
      COUNT(*) as opportunity_count,
      COUNT(DISTINCT o.patient_id) as patient_count,
      COALESCE(SUM(o.annual_margin_gain), 0) as annual_potential
    FROM opportunities o
    WHERE o.pharmacy_id = $1
    GROUP BY COALESCE(o.prescriber_name, 'Unknown')
    ORDER BY SUM(o.annual_margin_gain) DESC
    LIMIT 10
  `, [pharmacyId]);

  console.log('TOP PRESCRIBERS BY VALUE:');
  console.log('Prescriber'.padEnd(35), '| Opps  | Patients | Annual Value');
  console.log('-'.repeat(80));
  for (const r of topByValue.rows) {
    console.log(
      (r.prescriber_name || 'Unknown').substring(0,33).padEnd(35),
      '|', String(r.opportunity_count).padStart(5),
      '|', String(r.patient_count).padStart(8),
      '| $' + Number(r.annual_potential).toLocaleString()
    );
  }

  // Test recommended drug stats query
  const topDrugs = await pool.query(`
    SELECT
      COALESCE(o.recommended_drug, o.recommended_drug_name, 'Unknown') as recommended_drug,
      COUNT(*) as opportunity_count,
      COALESCE(SUM(o.annual_margin_gain), 0) as annual_potential
    FROM opportunities o
    WHERE o.pharmacy_id = $1
    GROUP BY COALESCE(o.recommended_drug, o.recommended_drug_name, 'Unknown')
    ORDER BY SUM(o.annual_margin_gain) DESC
    LIMIT 10
  `, [pharmacyId]);

  console.log('\nTOP RECOMMENDED DRUGS BY VALUE:');
  console.log('Drug'.padEnd(35), '| Opps  | Annual Value');
  console.log('-'.repeat(70));
  for (const r of topDrugs.rows) {
    console.log(
      (r.recommended_drug || 'Unknown').substring(0,33).padEnd(35),
      '|', String(r.opportunity_count).padStart(5),
      '| $' + Number(r.annual_potential).toLocaleString()
    );
  }

  await pool.end();
}

test().catch(console.error);
