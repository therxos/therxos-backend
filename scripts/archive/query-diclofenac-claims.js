import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Only Diclofenac 2% claims
const { rows } = await pool.query(`
  SELECT drug_name, ndc, quantity_dispensed as quantity, days_supply,
    COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0) - COALESCE(acquisition_cost, 0) as gross_profit,
    insurance_pay, patient_pay, acquisition_cost,
    dispensed_date, insurance_bin as bin, insurance_group as group_number
  FROM prescriptions
  WHERE UPPER(drug_name) LIKE '%DICLOFENAC%'
    AND POSITION('2%' IN UPPER(drug_name)) > 0
    AND dispensed_date >= '2025-09-01'
  ORDER BY (COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0) - COALESCE(acquisition_cost, 0)) DESC
`);

console.log('Diclofenac 2% claims since 9/1/25:', rows.length);
console.log('');
console.log('DATE        | DRUG NAME                                  | NDC           | QTY     | DS  | GP         | Ins Pay    | Pt Pay    | ACQ       | BIN/GROUP');
console.log('-'.repeat(170));
for (const r of rows) {
  const date = r.dispensed_date?.toISOString().slice(0,10) || 'N/A';
  const drug = (r.drug_name || '').padEnd(42);
  const ndc = (r.ndc || '').padEnd(14);
  const qty = String(r.quantity || '').padStart(7);
  const ds = String(r.days_supply || '').padStart(4);
  const gp = ('$' + Number(r.gross_profit || 0).toFixed(2)).padStart(10);
  const insPay = ('$' + Number(r.insurance_pay || 0).toFixed(2)).padStart(10);
  const ptPay = ('$' + Number(r.patient_pay || 0).toFixed(2)).padStart(9);
  const acq = ('$' + Number(r.acquisition_cost || 0).toFixed(2)).padStart(9);
  const binGrp = (r.bin || '') + '/' + (r.group_number || '');
  console.log(`${date} | ${drug} | ${ndc} | ${qty} | ${ds} | ${gp} | ${insPay} | ${ptPay} | ${acq} | ${binGrp}`);
}

console.log('');
console.log('=== SUMMARY BY DRUG NAME ===');
const byDrug = {};
for (const r of rows) {
  const key = r.drug_name || 'UNKNOWN';
  if (!byDrug[key]) byDrug[key] = { count: 0, totalGP: 0, qtys: [], ds: [] };
  byDrug[key].count++;
  byDrug[key].totalGP += Number(r.gross_profit || 0);
  byDrug[key].qtys.push(Number(r.quantity || 0));
  byDrug[key].ds.push(Number(r.days_supply || 0));
}
for (const [drug, data] of Object.entries(byDrug).sort((a,b) => b[1].totalGP - a[1].totalGP)) {
  const avgQty = (data.qtys.reduce((a,b)=>a+b,0) / data.count).toFixed(1);
  const avgDS = (data.ds.reduce((a,b)=>a+b,0) / data.count).toFixed(0);
  const avgGP = (data.totalGP / data.count).toFixed(2);
  console.log(`${drug}: ${data.count} claims, total GP: $${data.totalGP.toFixed(2)}, avg GP: $${avgGP}, avg Qty: ${avgQty}, avg DS: ${avgDS}`);
}

await pool.end();
