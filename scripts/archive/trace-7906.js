import 'dotenv/config';
import db from './src/database/index.js';

async function main() {
  // The bad BIN value was: BIN 610097/COS: GP $7906.33, qty 100.00, claims 3 - SAFETY 30G MIS LANCETS
  // Let's see what raw claims exist for that BIN/GROUP

  const claims = await db.query(`
    SELECT drug_name, ndc, days_supply, quantity_dispensed,
      raw_data->>'gross_profit' as raw_gp,
      COALESCE(
        NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0)
      ) as gp,
      COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END) as est_days
    FROM prescriptions
    WHERE insurance_bin = '610097'
      AND insurance_group = 'COS'
      AND UPPER(drug_name) LIKE '%LANCET%'
  `);

  console.log('=== BIN 610097/COS LANCET CLAIMS ===');
  claims.rows.forEach(r => {
    // The Verifine trigger has expected_qty=100, expected_days_supply=30
    // So normalization is: GP / GREATEST(ROUND(qty / 100), 1)
    const expectedQty = 100;
    const fillMultiple = Math.max(Math.round((r.quantity_dispensed || expectedQty) / expectedQty), 1);
    const normGp = r.gp / fillMultiple;

    console.log(r.drug_name);
    console.log('  raw GP:', r.raw_gp, '| computed GP:', r.gp);
    console.log('  days:', r.days_supply, '| qty:', r.quantity_dispensed);
    console.log('  fill multiple:', fillMultiple, '| normalized GP:', normGp.toFixed(2));
    console.log('');
  });

  // Now check: what if qty is 0 or NULL?
  // ROUND(0 / 100) = 0, GREATEST(0, 1) = 1, so GP/1 = GP unchanged
  // But wait... the scanner CTE has a NULL check on qty

  // Let me check the actual formula the scanner used
  // For expected_qty triggers:
  // gpNorm = GP / GREATEST(ROUND(COALESCE(quantity_dispensed, expected_qty) / expected_qty), 1)
  // If qty is NULL: COALESCE(NULL, 100) = 100, ROUND(100/100) = 1, GP/1 = GP

  // But wait - the BIN value shows 3 claims. Let me see all 3
  const allClaims = await db.query(`
    SELECT drug_name, days_supply, quantity_dispensed,
      COALESCE(
        NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0)
      ) as gp
    FROM prescriptions
    WHERE insurance_bin = '610097'
      AND insurance_group = 'COS'
      AND (UPPER(drug_name) LIKE '%LANCET%' OR UPPER(drug_name) LIKE '%SAFETY%')
  `);

  console.log('\n=== ALL BIN 610097/COS CLAIMS (lancet/safety) ===');
  let sum = 0;
  allClaims.rows.forEach(r => {
    console.log(r.drug_name + ' | days ' + r.days_supply + ' | qty ' + r.quantity_dispensed + ' | GP $' + r.gp);
    sum += parseFloat(r.gp || 0);
  });
  console.log('Sum:', sum, '| Count:', allClaims.rows.length, '| Avg:', (sum / allClaims.rows.length).toFixed(2));

  // Check what PERCENTILE_CONT would return
  // The scanner uses PERCENTILE_CONT(0.5) - median
  // If the 3 claims have GP of 79.63, 78.78, 78.78 the median would be 78.78, not 7906

  // THE BUG MUST BE IN THE AGGREGATION - let me check if SUM was used instead of median somewhere

  // Actually wait - the trigger has expected_qty=100, expected_days_supply=30
  // The daysFilter would be: days >= 24 (80% of 30)
  // But the claims have days=30 and qty=0

  // qty=0 means the gpCol becomes NULL:
  // CASE WHEN COALESCE(quantity_dispensed, 0) > 0 THEN gpNorm ELSE NULL END
  // So the GP should be NULL for qty=0 claims!

  // But PERCENTILE_CONT ignores NULLs... so if ALL claims have qty=0, there's no non-null GP to median
  // Let me check what happens

  console.log('\n=== CHECKING QTY=0 ISSUE ===');
  const zeroQty = await db.query(`
    SELECT COUNT(*) as cnt,
      COUNT(*) FILTER (WHERE COALESCE(quantity_dispensed, 0) = 0) as zero_qty
    FROM prescriptions
    WHERE insurance_bin = '610097'
      AND insurance_group = 'COS'
      AND UPPER(drug_name) LIKE '%LANCET%'
  `);
  console.log('Total claims:', zeroQty.rows[0].cnt, '| Zero qty:', zeroQty.rows[0].zero_qty);

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
