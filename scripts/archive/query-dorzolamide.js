import 'dotenv/config';
import db from './src/database/index.js';

async function run() {
  const result = await db.query(`
    SELECT
      UPPER(TRIM(drug_name)) as drug_name,
      ndc,
      COUNT(*) as claim_count,
      COUNT(DISTINCT patient_id) as patient_count,
      ROUND(AVG(COALESCE((raw_data->>'gross_profit')::numeric, 0))::numeric, 2) as avg_gp,
      ROUND(AVG(COALESCE(acquisition_cost, 0))::numeric, 2) as avg_acq,
      ROUND(AVG(quantity_dispensed)::numeric, 0) as avg_qty
    FROM prescriptions
    WHERE LOWER(drug_name) LIKE '%dorz%'
       OR LOWER(drug_name) LIKE '%timol%'
       OR LOWER(drug_name) LIKE '%cosopt%'
    GROUP BY UPPER(TRIM(drug_name)), ndc
    ORDER BY claim_count DESC
  `);

  console.log('\n=== DORZOLAMIDE-TIMOLOL VARIATIONS ===\n');
  for (const r of result.rows) {
    console.log(`${r.drug_name}  |  NDC: ${r.ndc || 'none'}  |  ${r.claim_count} claims, ${r.patient_count} patients  |  GP: $${r.avg_gp}  |  ACQ: $${r.avg_acq}  |  Qty: ${r.avg_qty}`);
  }
  console.log(`\nTotal variations found: ${result.rows.length}`);

  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
