import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';
const thresholdDollars = 20;
const thresholdPercent = 25;

async function test() {
  console.log('='.repeat(80));
  console.log('TESTING REIMBURSEMENT CHANGE SCANNER - HEIGHTS CHEMIST');
  console.log('='.repeat(80));
  console.log(`Thresholds: $${thresholdDollars} or ${thresholdPercent}%\n`);

  // Find prescriptions with multiple fills and compare reimbursements
  const rxChanges = await pool.query(`
    WITH rx_history AS (
      SELECT
        prescription_id,
        patient_id,
        rx_number,
        drug_name,
        ndc,
        insurance_bin,
        insurance_group,
        COALESCE(insurance_pay, 0) as insurance_pay,
        COALESCE(acquisition_cost, 0) as acquisition_cost,
        COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0) as gross_profit,
        dispensed_date,
        LAG(COALESCE(insurance_pay, 0)) OVER (
          PARTITION BY patient_id, UPPER(TRIM(drug_name))
          ORDER BY dispensed_date
        ) as prev_ins_pay,
        LAG(dispensed_date) OVER (
          PARTITION BY patient_id, UPPER(TRIM(drug_name))
          ORDER BY dispensed_date
        ) as prev_fill_date
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND insurance_pay IS NOT NULL
        AND insurance_pay > 0
    )
    SELECT *,
      insurance_pay - prev_ins_pay as pay_change,
      CASE
        WHEN prev_ins_pay > 0 THEN ((insurance_pay - prev_ins_pay) / prev_ins_pay * 100)
        ELSE 0
      END as pay_change_pct
    FROM rx_history
    WHERE prev_ins_pay IS NOT NULL
      AND (
        ABS(insurance_pay - prev_ins_pay) >= $2
        OR (prev_ins_pay > 0 AND ABS((insurance_pay - prev_ins_pay) / prev_ins_pay * 100) >= $3)
      )
    ORDER BY ABS(insurance_pay - prev_ins_pay) DESC
    LIMIT 100
  `, [pharmacyId, thresholdDollars, thresholdPercent]);

  const increases = rxChanges.rows.filter(r => r.pay_change > 0);
  const decreases = rxChanges.rows.filter(r => r.pay_change < 0);

  console.log(`Found ${rxChanges.rows.length} significant reimbursement changes`);
  console.log(`  - Increases: ${increases.length}`);
  console.log(`  - Decreases: ${decreases.length}`);

  // Show top increases
  console.log('\n' + '='.repeat(80));
  console.log('TOP REIMBURSEMENT INCREASES (Opportunities!)');
  console.log('='.repeat(80));
  console.log('Drug'.padEnd(35) + ' | BIN    | Prev Pay | New Pay  | Change   | Date');
  console.log('-'.repeat(95));

  for (const rx of increases.slice(0, 20)) {
    console.log(
      (rx.drug_name || '').substring(0, 33).padEnd(35),
      '|', (rx.insurance_bin || '').padEnd(6),
      '|', ('$' + Number(rx.prev_ins_pay).toFixed(2)).padStart(8),
      '|', ('$' + Number(rx.insurance_pay).toFixed(2)).padStart(8),
      '|', ('+$' + Number(rx.pay_change).toFixed(2)).padStart(8),
      '|', rx.dispensed_date?.toISOString().split('T')[0]
    );
  }

  // Show top decreases
  console.log('\n' + '='.repeat(80));
  console.log('TOP REIMBURSEMENT DECREASES (Watch out!)');
  console.log('='.repeat(80));
  console.log('Drug'.padEnd(35) + ' | BIN    | Prev Pay | New Pay  | Change   | Date');
  console.log('-'.repeat(95));

  for (const rx of decreases.slice(0, 20)) {
    console.log(
      (rx.drug_name || '').substring(0, 33).padEnd(35),
      '|', (rx.insurance_bin || '').padEnd(6),
      '|', ('$' + Number(rx.prev_ins_pay).toFixed(2)).padStart(8),
      '|', ('$' + Number(rx.insurance_pay).toFixed(2)).padStart(8),
      '|', ('-$' + Math.abs(Number(rx.pay_change)).toFixed(2)).padStart(8),
      '|', rx.dispensed_date?.toISOString().split('T')[0]
    );
  }

  // Summary by BIN
  console.log('\n' + '='.repeat(80));
  console.log('CHANGES BY BIN');
  console.log('='.repeat(80));

  const byBin = {};
  for (const rx of rxChanges.rows) {
    const bin = rx.insurance_bin || 'Unknown';
    if (!byBin[bin]) byBin[bin] = { increases: 0, decreases: 0, totalChange: 0 };
    if (rx.pay_change > 0) {
      byBin[bin].increases++;
    } else {
      byBin[bin].decreases++;
    }
    byBin[bin].totalChange += rx.pay_change;
  }

  console.log('BIN'.padEnd(10) + ' | Increases | Decreases | Net Change');
  console.log('-'.repeat(50));
  for (const [bin, data] of Object.entries(byBin).sort((a, b) => Math.abs(b[1].totalChange) - Math.abs(a[1].totalChange))) {
    console.log(
      bin.padEnd(10),
      '|', String(data.increases).padStart(9),
      '|', String(data.decreases).padStart(9),
      '|', (data.totalChange >= 0 ? '+$' : '-$') + Math.abs(data.totalChange).toFixed(2)
    );
  }

  await pool.end();
}

test().catch(console.error);
