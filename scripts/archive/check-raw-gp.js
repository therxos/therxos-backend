import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const result = await pool.query(`
    SELECT
      ph.pharmacy_name,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE rx.raw_data->>'net_profit' IS NOT NULL AND (rx.raw_data->>'net_profit')::numeric != 0) as has_gp_in_raw,
      COUNT(*) FILTER (WHERE rx.acquisition_cost IS NOT NULL AND rx.acquisition_cost != 0) as has_acq_cost,
      ROUND(AVG(CASE WHEN (rx.raw_data->>'net_profit') IS NOT NULL AND (rx.raw_data->>'net_profit')::numeric != 0 THEN (rx.raw_data->>'net_profit')::numeric END), 2) as avg_raw_gp,
      ROUND(AVG(CASE WHEN rx.insurance_pay IS NOT NULL AND rx.insurance_pay != 0 THEN rx.insurance_pay END), 2) as avg_ins_pay
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    GROUP BY ph.pharmacy_name
    ORDER BY ph.pharmacy_name
  `);

  console.log('=== Gross Profit in raw_data vs insurance_pay ===\n');
  for (const r of result.rows) {
    console.log(`${r.pharmacy_name} (${r.total} rx):`);
    console.log(`  GP in raw_data: ${r.has_gp_in_raw} rows (avg $${r.avg_raw_gp || 'N/A'})`);
    console.log(`  Has acq cost:   ${r.has_acq_cost} rows`);
    console.log(`  Avg ins_pay:    $${r.avg_ins_pay || 'N/A'}`);
    console.log('');
  }

  // Sample a few rows comparing raw GP vs insurance_pay
  const samples = await pool.query(`
    SELECT ph.pharmacy_name, rx.drug_name, rx.insurance_pay, rx.acquisition_cost, rx.patient_pay,
           (rx.raw_data->>'net_profit')::numeric as raw_gp
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    WHERE rx.raw_data->>'net_profit' IS NOT NULL AND (rx.raw_data->>'net_profit')::numeric != 0
    ORDER BY ph.pharmacy_name
    LIMIT 20
  `);

  console.log('=== Sample rows: raw GP vs insurance_pay ===\n');
  for (const r of samples.rows) {
    console.log(`${r.pharmacy_name} | ${r.drug_name}`);
    console.log(`  ins_pay=$${r.insurance_pay} | acq=$${r.acquisition_cost} | pat_pay=$${r.patient_pay} | raw GP=$${r.raw_gp}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
