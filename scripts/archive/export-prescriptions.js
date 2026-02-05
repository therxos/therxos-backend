import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  console.log('Querying prescriptions...');
  const result = await pool.query(`
    SELECT
      ph.pharmacy_name,
      pat.first_name as patient_first_name,
      pat.last_name as patient_last_name,
      pat.date_of_birth,
      rx.rx_number,
      rx.drug_name,
      rx.ndc,
      rx.quantity_dispensed,
      rx.days_supply,
      rx.daw_code,
      rx.prescriber_name,
      rx.prescriber_npi,
      rx.insurance_bin,
      rx.insurance_pcn,
      rx.insurance_group,
      rx.contract_id,
      rx.plan_name,
      rx.patient_pay,
      rx.insurance_pay,
      rx.acquisition_cost,
      COALESCE(
        NULLIF((rx.raw_data->>'gross_profit')::numeric, 0),
        NULLIF((rx.raw_data->>'net_profit')::numeric, 0),
        NULLIF((rx.raw_data->>'Gross Profit')::numeric, 0),
        NULLIF((rx.raw_data->>'Net Profit')::numeric, 0)
      ) as gross_profit,
      rx.dispensed_date,
      rx.written_date,
      rx.is_new_rx,
      rx.is_refill,
      rx.refills_remaining,
      rx.source_file
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    LEFT JOIN patients pat ON pat.patient_id = rx.patient_id
    WHERE ph.pharmacy_name NOT ILIKE '%marvel%'
      AND ph.pharmacy_name NOT ILIKE '%hero%'
    ORDER BY ph.pharmacy_name, rx.dispensed_date DESC
  `);

  console.log(`Got ${result.rows.length} rows, building CSV...`);

  const headers = Object.keys(result.rows[0]);
  const lines = [headers.join(',')];

  for (const row of result.rows) {
    const vals = headers.map(h => {
      let v = row[h];
      if (v === null || v === undefined) return '';
      if (v instanceof Date) return v.toISOString().split('T')[0];
      v = String(v);
      if (v.includes(',') || v.includes('"') || v.includes('\n')) {
        return '"' + v.replace(/"/g, '""') + '"';
      }
      return v;
    });
    lines.push(vals.join(','));
  }

  const outPath = 'C:/Users/Stan/Desktop/therxos-prescriptions-export-v3.csv';
  fs.writeFileSync(outPath, lines.join('\n'));
  console.log(`Exported ${result.rows.length} rows to ${outPath}`);
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
