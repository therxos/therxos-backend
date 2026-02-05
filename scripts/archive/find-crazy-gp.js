import 'dotenv/config';
import db from './src/database/index.js';

async function main() {
  // Find any prescription with GP over 500
  const crazy = await db.query(`
    SELECT drug_name, ndc, insurance_bin, insurance_group, days_supply, quantity_dispensed,
      raw_data->>'gross_profit' as raw_gp,
      raw_data->>'Gross Profit' as raw_gp2,
      raw_data->>'net_profit' as raw_net,
      COALESCE(
        NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0)
      ) as computed_gp,
      dispensed_date
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%LANCET%'
      AND COALESCE(
        NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0)
      ) > 500
    ORDER BY computed_gp DESC
    LIMIT 20
  `);
  console.log('=== LANCET CLAIMS WITH GP > $500 ===');
  if (crazy.rows.length === 0) {
    console.log('None found - the $7900 is a calculation error, not raw data');
  }
  crazy.rows.forEach(r => {
    console.log(r.drug_name + ' | BIN ' + r.insurance_bin + '/' + (r.insurance_group||'') + ' | days ' + r.days_supply + ' | qty ' + r.quantity_dispensed);
    console.log('  raw_gp:', r.raw_gp, '| raw_gp2:', r.raw_gp2, '| raw_net:', r.raw_net, '| computed:', r.computed_gp);
    console.log('');
  });

  // Also check what the scanner would have calculated
  // The scanner normalizes to 30-day: GP / CEIL(days_supply / 30)
  // If days_supply is 100 and we don't ceil properly...
  const sample = await db.query(`
    SELECT drug_name, days_supply, quantity_dispensed,
      COALESCE(
        NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0)
      ) as raw_gp,
      COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END) as est_days
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%SAFETY%LANCET%'
       OR UPPER(drug_name) LIKE '%LANCET%DEVICE%'
    ORDER BY raw_gp DESC NULLS LAST
    LIMIT 10
  `);
  console.log('\n=== SAFETY LANCET / LANCET DEVICE CLAIMS ===');
  sample.rows.forEach(r => {
    const normGp = r.raw_gp / Math.max(Math.ceil(r.est_days / 30), 1);
    console.log(r.drug_name + ' | days ' + r.days_supply + ' (est ' + r.est_days + ') | qty ' + r.quantity_dispensed + ' | raw GP $' + r.raw_gp + ' | norm GP $' + normGp.toFixed(2));
  });

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
