import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const result = await pool.query(`
    SELECT
      ph.pharmacy_name,
      p.drug_name, p.ndc, p.insurance_bin, p.insurance_group,
      p.quantity_dispensed,
      (p.raw_data->>'gross_profit') as gp_lowercase,
      (p.raw_data->>'net_profit') as np_lowercase,
      (p.raw_data->>'Gross Profit') as gp_caps,
      (p.raw_data->>'Net Profit') as np_caps,
      COALESCE(
        (p.raw_data->>'gross_profit')::numeric,
        (p.raw_data->>'net_profit')::numeric,
        (p.raw_data->>'Gross Profit')::numeric,
        (p.raw_data->>'Net Profit')::numeric
      ) as actual_gp
    FROM prescriptions p
    JOIN pharmacies ph ON ph.pharmacy_id = p.pharmacy_id
    WHERE UPPER(p.drug_name) LIKE '%ARIPIPRAZOLE%'
      AND (UPPER(p.drug_name) LIKE '%ODT%' OR UPPER(p.drug_name) LIKE '%ORALLY%' OR UPPER(p.drug_name) LIKE '%DISINT%')
    ORDER BY actual_gp DESC NULLS LAST
    LIMIT 20
  `);

  console.log('=== Aripiprazole ODT claims with GP data ===');
  for (const r of result.rows) {
    console.log(`${r.pharmacy_name} | ${r.drug_name} | NDC:${r.ndc} | BIN:${r.insurance_bin} GRP:${r.insurance_group} | qty:${r.quantity_dispensed} | GP:$${r.actual_gp} | keys: gp=${r.gp_lowercase} np=${r.np_lowercase} GP=${r.gp_caps} NP=${r.np_caps}`);
  }

  // Also check: what does the trigger look like?
  const trigger = await pool.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc, detection_keywords
    FROM triggers WHERE display_name ILIKE '%aripiprazole%odt%'
  `);
  if (trigger.rows[0]) {
    const t = trigger.rows[0];
    console.log(`\n=== Trigger ===`);
    console.log(`Name: ${t.display_name}`);
    console.log(`Recommended Drug: ${t.recommended_drug}`);
    console.log(`Recommended NDC: ${t.recommended_ndc}`);
    console.log(`Detection Keywords: ${JSON.stringify(t.detection_keywords)}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
