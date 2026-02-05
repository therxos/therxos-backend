import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function investigate() {
  console.log('='.repeat(80));
  console.log('INVESTIGATING OPPORTUNITY VALUE DISCREPANCY');
  console.log('='.repeat(80));

  // Check all numeric columns that could be summed
  const sums = await pool.query(`
    SELECT
      COUNT(*) as total_opps,
      SUM(annual_margin_gain) as sum_annual_margin_gain,
      SUM(potential_margin_gain) as sum_potential_margin_gain,
      SUM(COALESCE(current_margin, 0)) as sum_current_margin,
      SUM(COALESCE(recommended_margin, 0)) as sum_recommended_margin,
      SUM(COALESCE(patient_savings, 0)) as sum_patient_savings,
      SUM(COALESCE(actual_margin_realized, 0)) as sum_actual_margin_realized
    FROM opportunities
    WHERE pharmacy_id = $1
  `, [pharmacyId]);

  console.log('\nSum of different value columns:');
  const row = sums.rows[0];
  console.log('  total_opps:', row.total_opps);
  console.log('  annual_margin_gain:', '$' + Number(row.sum_annual_margin_gain || 0).toLocaleString());
  console.log('  potential_margin_gain:', '$' + Number(row.sum_potential_margin_gain || 0).toLocaleString());
  console.log('  current_margin:', '$' + Number(row.sum_current_margin || 0).toLocaleString());
  console.log('  recommended_margin:', '$' + Number(row.sum_recommended_margin || 0).toLocaleString());
  console.log('  patient_savings:', '$' + Number(row.sum_patient_savings || 0).toLocaleString());
  console.log('  actual_margin_realized:', '$' + Number(row.sum_actual_margin_realized || 0).toLocaleString());

  // Check if there might be some opportunities with very high values
  console.log('\n' + '='.repeat(80));
  console.log('TOP 20 OPPORTUNITIES BY annual_margin_gain:');
  console.log('='.repeat(80));

  const topByAnnual = await pool.query(`
    SELECT opportunity_id, current_drug_name, recommended_drug,
           annual_margin_gain, potential_margin_gain, avg_dispensed_qty,
           opportunity_type
    FROM opportunities
    WHERE pharmacy_id = $1
    ORDER BY annual_margin_gain DESC
    LIMIT 20
  `, [pharmacyId]);

  console.log('Current Drug'.padEnd(35) + ' | Annual GP  | Potential  | Avg Qty | Type');
  console.log('-'.repeat(100));
  for (const r of topByAnnual.rows) {
    console.log(
      (r.current_drug_name || '').substring(0, 33).padEnd(35),
      '|', ('$' + Number(r.annual_margin_gain || 0).toFixed(2)).padStart(10),
      '|', ('$' + Number(r.potential_margin_gain || 0).toFixed(2)).padStart(10),
      '|', String(r.avg_dispensed_qty || '').padStart(7),
      '|', (r.opportunity_type || '').substring(0, 15)
    );
  }

  // Check if there are opportunities with NULL or weird values
  console.log('\n' + '='.repeat(80));
  console.log('VALUE DISTRIBUTION:');
  console.log('='.repeat(80));

  const distribution = await pool.query(`
    SELECT
      CASE
        WHEN annual_margin_gain IS NULL THEN 'NULL'
        WHEN annual_margin_gain = 0 THEN '$0'
        WHEN annual_margin_gain < 50 THEN '$1-49'
        WHEN annual_margin_gain < 100 THEN '$50-99'
        WHEN annual_margin_gain < 200 THEN '$100-199'
        WHEN annual_margin_gain < 500 THEN '$200-499'
        WHEN annual_margin_gain < 1000 THEN '$500-999'
        WHEN annual_margin_gain < 10000 THEN '$1k-10k'
        ELSE '$10k+'
      END as range,
      COUNT(*) as cnt,
      SUM(annual_margin_gain) as total
    FROM opportunities
    WHERE pharmacy_id = $1
    GROUP BY 1
    ORDER BY MIN(annual_margin_gain) NULLS FIRST
  `, [pharmacyId]);

  for (const r of distribution.rows) {
    console.log('  ' + r.range.padEnd(15) + ': ' + String(r.cnt).padStart(5) + ' opps | $' + Number(r.total || 0).toLocaleString());
  }

  // Check the opportunities endpoint logic - what does it actually calculate?
  // Let's see if there's multiplication by frequency or something
  console.log('\n' + '='.repeat(80));
  console.log('CHECKING FOR FREQUENCY MULTIPLIERS:');
  console.log('='.repeat(80));

  // Check if avg_dispensed_qty might be used as a multiplier
  const withQty = await pool.query(`
    SELECT
      COUNT(*) as cnt,
      SUM(annual_margin_gain) as sum_annual,
      SUM(annual_margin_gain * COALESCE(avg_dispensed_qty, 1)) as sum_with_qty_multiplier,
      SUM(potential_margin_gain * 12) as sum_potential_x12
    FROM opportunities
    WHERE pharmacy_id = $1
  `, [pharmacyId]);

  const qtyRow = withQty.rows[0];
  console.log('  SUM(annual_margin_gain):', '$' + Number(qtyRow.sum_annual || 0).toLocaleString());
  console.log('  SUM(annual * avg_qty):', '$' + Number(qtyRow.sum_with_qty_multiplier || 0).toLocaleString());
  console.log('  SUM(potential * 12):', '$' + Number(qtyRow.sum_potential_x12 || 0).toLocaleString());

  // Check if the $1.9M could be monthly * 12
  console.log('\n  If monthly is $165k, annual would be:', '$' + (165000 * 12).toLocaleString());
  console.log('  $1.9M / 12 =', '$' + (1900000 / 12).toLocaleString(), '(monthly)');

  await pool.end();
}

investigate().catch(console.error);
