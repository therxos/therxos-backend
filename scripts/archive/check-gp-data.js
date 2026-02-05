import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Check all columns
  const cols = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'prescriptions' ORDER BY ordinal_position");
  console.log('All columns:');
  cols.rows.forEach(c => console.log('  ', c.column_name, '-', c.data_type));

  // Data completeness by pharmacy
  const stats = await pool.query(`
    SELECT
      ph.pharmacy_name,
      COUNT(*) as total,
      COUNT(rx.insurance_pay) as has_ins_pay,
      COUNT(rx.patient_pay) as has_pat_pay,
      COUNT(rx.acquisition_cost) as has_acq_cost,
      COUNT(*) FILTER (WHERE rx.acquisition_cost IS NULL OR rx.acquisition_cost = 0) as missing_acq,
      COUNT(*) FILTER (WHERE rx.patient_pay IS NULL OR rx.patient_pay = 0) as missing_pat_pay,
      COUNT(*) FILTER (WHERE rx.insurance_pay = (COALESCE(rx.patient_pay,0) + COALESCE(rx.insurance_pay,0) - COALESCE(rx.acquisition_cost,0))) as gp_equals_ins_pay
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    GROUP BY ph.pharmacy_name
    ORDER BY ph.pharmacy_name
  `);

  console.log('\n=== Data Completeness by Pharmacy ===');
  for (const r of stats.rows) {
    console.log(`\n${r.pharmacy_name} (${r.total} rx):`);
    console.log(`  has insurance_pay: ${r.has_ins_pay}`);
    console.log(`  has patient_pay: ${r.has_pat_pay}`);
    console.log(`  has acquisition_cost: ${r.has_acq_cost}`);
    console.log(`  missing acq cost: ${r.missing_acq}`);
    console.log(`  missing pat pay: ${r.missing_pat_pay}`);
    console.log(`  GP = insurance_pay (no acq/pat): ${r.gp_equals_ins_pay}`);
  }

  // Sample from each pharmacy
  const samples = await pool.query(`
    SELECT DISTINCT ON (ph.pharmacy_name)
      ph.pharmacy_name, rx.drug_name, rx.patient_pay, rx.insurance_pay, rx.acquisition_cost
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    WHERE rx.insurance_pay IS NOT NULL AND rx.insurance_pay > 0
    ORDER BY ph.pharmacy_name, rx.dispensed_date DESC
  `);
  console.log('\n=== Sample Row per Pharmacy ===');
  for (const r of samples.rows) {
    const calcGP = (Number(r.patient_pay||0) + Number(r.insurance_pay||0) - Number(r.acquisition_cost||0)).toFixed(2);
    console.log(`${r.pharmacy_name}: ${r.drug_name}`);
    console.log(`  pat_pay=$${r.patient_pay} ins_pay=$${r.insurance_pay} acq=$${r.acquisition_cost} => calc GP=$${calcGP}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
