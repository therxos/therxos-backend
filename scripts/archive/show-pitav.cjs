require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const result = await pool.query(`
    SELECT
      p.pharmacy_name,
      pat.first_name || ' ' || pat.last_name as patient_name,
      o.opportunity_id,
      o.status,
      o.annual_margin_gain,
      o.recommended_drug_name,
      o.recommended_ndc,
      o.avg_dispensed_qty,
      o.current_drug_name,
      o.staff_notes,
      o.created_at
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    JOIN patients pat ON pat.patient_id = o.patient_id
    WHERE (o.recommended_drug_name ILIKE '%pitav%' OR o.recommended_drug ILIKE '%pitav%')
    ORDER BY p.pharmacy_name, pat.last_name, pat.first_name, o.created_at
    LIMIT 30
  `);

  console.log('PITAVASTATIN OPPORTUNITIES:');
  console.log('===========================\n');

  let lastPatient = '';
  for (const r of result.rows) {
    const patientKey = `${r.pharmacy_name} | ${r.patient_name}`;
    if (patientKey !== lastPatient) {
      console.log('\n' + patientKey);
      console.log('-'.repeat(patientKey.length));
      lastPatient = patientKey;
    }
    console.log(`  ${r.status.padEnd(14)} | Qty: ${String(r.avg_dispensed_qty || 'null').padEnd(6)} | $${r.annual_margin_gain}/yr | NDC: ${r.recommended_ndc || 'null'} | Created: ${new Date(r.created_at).toLocaleDateString()}`);
  }

  await pool.end();
}
run();
