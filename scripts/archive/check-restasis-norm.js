import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Check Restasis/Cyclosporine ophthalmic claims with raw data
  const claims = await pool.query(`
    SELECT drug_name, ndc, quantity_dispensed, days_supply,
           insurance_bin, insurance_group,
           COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric,
                    (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0) as raw_gp,
           raw_data->>'Days Supply' as raw_days,
           raw_data->>'Dispensing Unit' as unit
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%CYCLOSPORINE%' AND (UPPER(drug_name) LIKE '%EY%' OR UPPER(drug_name) LIKE '%OPHTHAL%' OR UPPER(drug_name) LIKE '%RESTASIS%')
    ORDER BY quantity_dispensed DESC
    LIMIT 30
  `);
  console.log('Restasis/Cyclosporine ophthalmic claims:');
  claims.rows.forEach(r => {
    const ds = r.days_supply || 'NULL';
    const months = Math.ceil((r.days_supply || (r.quantity_dispensed > 60 ? 90 : r.quantity_dispensed > 34 ? 60 : 30)) / 30);
    const gp30 = (r.raw_gp / months).toFixed(2);
    const qty30 = (r.quantity_dispensed / months).toFixed(1);
    console.log(`  ${r.drug_name} | qty: ${r.quantity_dispensed} | days: ${ds} | raw_gp: $${r.raw_gp} | months: ${months} | gp_30d: $${gp30} | qty_30d: ${qty30} | bin: ${r.insurance_bin} | unit: ${r.unit}`);
  });

  // Check the stored bin_values for the Restasis trigger
  const trigger = await pool.query(`
    SELECT t.trigger_id, t.display_name, t.recommended_ndc
    FROM triggers t
    WHERE LOWER(t.display_name) LIKE '%restasis%' OR LOWER(t.display_name) LIKE '%cyclosporine%'
  `);
  console.log('\nRestasis triggers:');
  for (const t of trigger.rows) {
    console.log(`  ${t.display_name} (ndc: ${t.recommended_ndc})`);
    const bvs = await pool.query(`
      SELECT insurance_bin, insurance_group, gp_value, avg_qty, avg_reimbursement, best_ndc, best_drug_name, verified_claim_count
      FROM trigger_bin_values
      WHERE trigger_id = $1
      ORDER BY gp_value DESC
      LIMIT 10
    `, [t.trigger_id]);
    bvs.rows.forEach(bv => {
      console.log(`    BIN: ${bv.insurance_bin}/${bv.insurance_group || '*'} | gp: $${bv.gp_value} | avg_qty: ${bv.avg_qty} | avg_reimb: $${bv.avg_reimbursement} | claims: ${bv.verified_claim_count} | ndc: ${bv.best_ndc}`);
    });
  }

  // Check what the opportunity looks like
  const opp = await pool.query(`
    SELECT o.opportunity_id, o.current_drug_name, o.recommended_drug_name, o.recommended_ndc,
           o.potential_margin_gain, o.annual_margin_gain, o.avg_dispensed_qty,
           p.first_name, p.last_name
    FROM opportunities o
    JOIN patients p ON p.patient_id = o.patient_id
    WHERE LOWER(p.first_name) = 'daniel' AND LOWER(p.last_name) = 'haddad'
    AND (LOWER(o.current_drug_name) LIKE '%restasis%' OR LOWER(o.recommended_drug_name) LIKE '%cyclosporine%')
  `);
  console.log('\nDaniel Haddad Restasis opportunity:');
  opp.rows.forEach(r => {
    console.log(`  Current: ${r.current_drug_name}`);
    console.log(`  Recommended: ${r.recommended_drug_name} (NDC: ${r.recommended_ndc})`);
    console.log(`  Potential: $${r.potential_margin_gain}`);
    console.log(`  Annual: $${r.annual_margin_gain}`);
    console.log(`  Avg Qty: ${r.avg_dispensed_qty}`);
  });

  // Also check dexlansoprazole
  const dex = await pool.query(`
    SELECT drug_name, quantity_dispensed, days_supply,
           COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'Gross Profit')::numeric, 0) as raw_gp
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%DEXLANSOPRAZOLE%'
    ORDER BY days_supply ASC
    LIMIT 10
  `);
  console.log('\nDexlansoprazole claims (sorted by days_supply):');
  dex.rows.forEach(r => {
    console.log(`  ${r.drug_name} | qty: ${r.quantity_dispensed} | days: ${r.days_supply} | gp: $${r.raw_gp}`);
  });

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
