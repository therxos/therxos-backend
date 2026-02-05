import 'dotenv/config';
import db from './src/database/index.js';

async function main() {
  // Get Verifine Lancets trigger data
  const trigger = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc, default_gp_value,
           expected_qty, expected_days_supply, trigger_type
    FROM triggers
    WHERE display_name ILIKE '%verifine%'
  `);
  console.log('=== VERIFINE TRIGGER ===');
  console.log(trigger.rows[0]);

  if (trigger.rows[0]) {
    const tid = trigger.rows[0].trigger_id;

    // Check BIN values
    const bins = await db.query(`
      SELECT insurance_bin, insurance_group, gp_value, avg_qty, best_drug_name, verified_claim_count
      FROM trigger_bin_values
      WHERE trigger_id = $1 AND (is_excluded = false OR is_excluded IS NULL)
      ORDER BY gp_value DESC
    `, [tid]);
    console.log('\n=== BIN VALUES ===');
    bins.rows.forEach(r => console.log('BIN ' + r.insurance_bin + '/' + (r.insurance_group||'') + ': GP $' + r.gp_value + ', qty ' + r.avg_qty + ', claims ' + r.verified_claim_count + ' - ' + r.best_drug_name));

    // Check opportunities with this trigger
    const opps = await db.query(`
      SELECT o.potential_margin_gain, o.annual_margin_gain, o.recommended_drug_name, o.recommended_ndc,
             p.pharmacy_name
      FROM opportunities o
      JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
      WHERE o.trigger_id = $1
      ORDER BY o.potential_margin_gain DESC
      LIMIT 10
    `, [tid]);
    console.log('\n=== VERIFINE OPPORTUNITIES (TOP 10 BY GP) ===');
    opps.rows.forEach(r => console.log(r.pharmacy_name + ': GP $' + r.potential_margin_gain + '/mo, $' + r.annual_margin_gain + '/yr - ' + r.recommended_drug_name));
  }

  // Also check if there are claims for lancets generally
  const lancetClaims = await db.query(`
    SELECT drug_name, insurance_bin, days_supply, quantity_dispensed,
      COALESCE(
        NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
        NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0)
      ) as gp
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%LANCET%'
    ORDER BY gp DESC NULLS LAST
    LIMIT 10
  `);
  console.log('\n=== ACTUAL LANCET CLAIMS (TOP GP) ===');
  lancetClaims.rows.forEach(r => console.log(r.drug_name + ' | BIN ' + r.insurance_bin + ' | days ' + r.days_supply + ' | qty ' + r.quantity_dispensed + ' | GP $' + r.gp));

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
