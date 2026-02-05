import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // What does the trigger look like?
  const trigger = await pool.query(`
    SELECT trigger_id, display_name, detection_keywords, recommended_drug
    FROM triggers WHERE display_name ILIKE '%aripiprazole%odt%' OR detection_keywords::text ILIKE '%aripiprazole%odt%'
  `);
  console.log('=== Trigger ===');
  console.log(trigger.rows[0] || 'NOT FOUND');

  // What Aripiprazole ODT claims exist in prescriptions?
  const claims = await pool.query(`
    SELECT ph.pharmacy_name, rx.drug_name, rx.insurance_bin, rx.insurance_group,
           rx.insurance_pay, rx.patient_pay, rx.acquisition_cost,
           (rx.raw_data->>'gross_profit')::numeric as raw_gp,
           (rx.raw_data->>'net_profit')::numeric as raw_net_profit,
           (rx.raw_data->>'Gross Profit')::numeric as raw_gp2,
           rx.quantity_dispensed, rx.days_supply, rx.dispensed_date
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    WHERE rx.drug_name ILIKE '%aripiprazole%odt%'
       OR rx.drug_name ILIKE '%aripiprazole%orally%'
       OR rx.drug_name ILIKE '%aripiprazole%disint%'
    ORDER BY ph.pharmacy_name, rx.dispensed_date DESC
  `);
  console.log(`\n=== Aripiprazole ODT Claims (${claims.rows.length} total) ===`);
  for (const r of claims.rows) {
    const gp = r.raw_gp || r.raw_net_profit || r.raw_gp2 || null;
    console.log(`${r.pharmacy_name} | ${r.drug_name} | BIN:${r.insurance_bin} GRP:${r.insurance_group} | ins_pay:$${r.insurance_pay} | raw GP:$${gp} | qty:${r.quantity_dispensed} days:${r.days_supply} | ${r.dispensed_date}`);
  }

  // Also check plain aripiprazole (not just ODT)
  const allArip = await pool.query(`
    SELECT ph.pharmacy_name, rx.drug_name, rx.insurance_bin, rx.insurance_group,
           rx.insurance_pay, rx.patient_pay, rx.acquisition_cost,
           COALESCE(
             (rx.raw_data->>'gross_profit')::numeric,
             (rx.raw_data->>'net_profit')::numeric,
             (rx.raw_data->>'Gross Profit')::numeric,
             (rx.raw_data->>'Net Profit')::numeric
           ) as gp,
           rx.quantity_dispensed, rx.days_supply
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    WHERE rx.drug_name ILIKE '%aripiprazole%'
    AND ph.pharmacy_name NOT ILIKE '%marvel%'
    ORDER BY COALESCE(
             (rx.raw_data->>'gross_profit')::numeric,
             (rx.raw_data->>'net_profit')::numeric,
             (rx.raw_data->>'Gross Profit')::numeric,
             (rx.raw_data->>'Net Profit')::numeric
           ) DESC NULLS LAST
    LIMIT 30
  `);
  console.log(`\n=== Top 30 Aripiprazole claims by GP ===`);
  for (const r of allArip.rows) {
    console.log(`${r.pharmacy_name} | ${r.drug_name} | BIN:${r.insurance_bin} GRP:${r.insurance_group} | GP:$${r.gp} | ins_pay:$${r.insurance_pay} | qty:${r.quantity_dispensed} days:${r.days_supply}`);
  }

  // Check what the coverage scanner would find
  if (trigger.rows[0]) {
    const tid = trigger.rows[0].trigger_id;
    const binValues = await pool.query(`
      SELECT * FROM trigger_bin_values WHERE trigger_id = $1
    `, [tid]);
    console.log(`\n=== Current trigger_bin_values for this trigger (${binValues.rows.length} entries) ===`);
    for (const r of binValues.rows) {
      console.log(`BIN:${r.insurance_bin} GRP:${r.insurance_group} | GP:$${r.gp_value} | status:${r.coverage_status} | claims:${r.verified_claim_count} | avg_reimb:$${r.avg_reimbursement} | avg_qty:${r.avg_qty}`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
