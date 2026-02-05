import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Look at raw_data profit fields for Diclofenac 2% claims
const { rows } = await pool.query(`
  SELECT drug_name, ndc, quantity_dispensed, days_supply,
    raw_data->>'gross_profit' as gp_raw,
    raw_data->>'Gross Profit' as gp_raw2,
    raw_data->>'net_profit' as np_raw,
    raw_data->>'Net Profit' as np_raw2,
    raw_data->>'adj_profit' as ap_raw,
    raw_data->>'Adj Profit' as ap_raw2,
    raw_data->>'Adjusted Profit' as ap_raw3,
    raw_data->>'Price' as price,
    raw_data->>'Actual Cost' as actual_cost,
    insurance_pay, patient_pay, acquisition_cost,
    dispensed_date, insurance_bin, insurance_group
  FROM prescriptions
  WHERE UPPER(drug_name) LIKE '%DICLOFENAC%'
    AND POSITION('2%' IN UPPER(drug_name)) > 0
    AND dispensed_date >= '2025-09-01'
  ORDER BY dispensed_date DESC
`);

console.log('Diclofenac 2% claims:', rows.length);
console.log('');
for (const r of rows) {
  const date = r.dispensed_date?.toISOString().slice(0,10);
  console.log(date, '|', r.drug_name, '| NDC:', r.ndc, '| Qty:', r.quantity_dispensed, '| DS:', r.days_supply);
  console.log('  raw gross_profit:', r.gp_raw, '| Gross Profit:', r.gp_raw2);
  console.log('  raw net_profit:', r.np_raw, '| Net Profit:', r.np_raw2);
  console.log('  raw adj_profit:', r.ap_raw, '| Adj Profit:', r.ap_raw2, '| Adjusted Profit:', r.ap_raw3);
  console.log('  Price:', r.price, '| Actual Cost:', r.actual_cost);
  console.log('  ins_pay:', r.insurance_pay, '| pt_pay:', r.patient_pay, '| acq_cost:', r.acquisition_cost);
  console.log('  BIN:', r.insurance_bin, '| Group:', r.insurance_group);
  console.log('');
}

await pool.end();
