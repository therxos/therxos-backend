import 'dotenv/config';
import db from './src/database/index.js';

async function main() {
  // Simulate the exact scanner query for Verifine trigger on BIN 610097/COS
  // Trigger: expected_qty=100, expected_days_supply=30

  const expectedQty = 100;
  const minDays = Math.floor(30 * 0.8); // 24

  const GP_SQL = `COALESCE(
    NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
    NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
    NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0)
  )`;

  const DAYS_SUPPLY_EST = `COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END)`;

  // For expected_qty triggers:
  const gpNorm = `${GP_SQL} / GREATEST(ROUND(COALESCE(quantity_dispensed, ${expectedQty})::numeric / ${expectedQty}), 1)`;
  const daysFilter = `${DAYS_SUPPLY_EST} >= ${minDays}`;

  // gpCol nulls out qty=0 claims
  const gpCol = `CASE WHEN COALESCE(quantity_dispensed, 0) > 0 THEN ${gpNorm} ELSE NULL END`;

  // Run the exact query the scanner would run
  const result = await db.query(`
    SELECT drug_name, insurance_bin, insurance_group, quantity_dispensed, days_supply,
      ${GP_SQL} as raw_gp,
      ${gpNorm} as gp_norm_formula,
      ${gpCol} as gp_col_value,
      COALESCE(quantity_dispensed, 0) > 0 as qty_positive
    FROM prescriptions
    WHERE insurance_bin = '610097'
      AND insurance_group = 'COS'
      AND UPPER(drug_name) LIKE '%SAFETY%LANCET%'
    ORDER BY raw_gp DESC NULLS LAST
    LIMIT 10
  `);

  console.log('=== SIMULATING SCANNER FORMULA FOR SAFETY LANCET CLAIMS ===');
  result.rows.forEach(r => {
    console.log(r.drug_name);
    console.log('  qty:', r.quantity_dispensed, '| days:', r.days_supply);
    console.log('  raw GP:', r.raw_gp);
    console.log('  gpNorm (formula result):', r.gp_norm_formula);
    console.log('  gpCol (with qty>0 check):', r.gp_col_value);
    console.log('  qty_positive:', r.qty_positive);
    console.log('');
  });

  // Now run the full aggregation to see what PERCENTILE_CONT returns
  const agg = await db.query(`
    WITH raw_claims AS (
      SELECT drug_name,
        ${gpCol} as gp_30day
      FROM prescriptions
      WHERE insurance_bin = '610097'
        AND insurance_group = 'COS'
        AND (UPPER(drug_name) LIKE '%LANCET%' OR UPPER(drug_name) LIKE '%SAFETY%')
        AND ${daysFilter}
        AND ${GP_SQL} > 0
    )
    SELECT
      COUNT(*) as claim_count,
      COUNT(*) FILTER (WHERE gp_30day IS NOT NULL) as non_null_count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gp_30day) as median_gp,
      AVG(gp_30day) as avg_gp,
      SUM(gp_30day) as sum_gp
    FROM raw_claims
  `);

  console.log('=== AGGREGATION RESULT ===');
  console.log(agg.rows[0]);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
