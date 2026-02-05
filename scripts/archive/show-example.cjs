require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Show one specific example in full detail
  const result = await pool.query(`
    SELECT
      o.opportunity_id,
      o.status,
      o.annual_margin_gain,
      o.recommended_drug_name,
      o.recommended_ndc,
      o.avg_dispensed_qty,
      o.current_drug_name,
      o.staff_notes,
      o.actioned_at,
      o.created_at
    FROM opportunities o
    JOIN patients pat ON pat.patient_id = o.patient_id
    WHERE pat.first_name || ' ' || pat.last_name = 'Fredis Brea'
      AND o.recommended_drug_name ILIKE '%Glucose%'
    ORDER BY o.created_at
  `);

  console.log('EXAMPLE: Fredis Brea - Glucose Test Strips');
  console.log('==========================================');
  console.log('This patient has ' + result.rows.length + ' opportunities for the same thing:\n');

  for (const r of result.rows) {
    console.log('ID: ' + r.opportunity_id);
    console.log('  Status: ' + r.status);
    console.log('  Margin: $' + r.annual_margin_gain + '/yr');
    console.log('  NDC: ' + r.recommended_ndc);
    console.log('  Qty: ' + r.avg_dispensed_qty);
    console.log('  Current Drug: ' + r.current_drug_name);
    console.log('  Notes: ' + (r.staff_notes || '(none)'));
    console.log('  Created: ' + r.created_at);
    console.log('  Actioned: ' + r.actioned_at);
    console.log('');
  }

  await pool.end();
}
run();
