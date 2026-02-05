import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Check current state of Aripiprazole ODT trigger
  const trigger = await pool.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc,
           default_gp_value, annual_fills, keyword_match_mode,
           bin_inclusions, bin_exclusions, group_inclusions, group_exclusions,
           detection_keywords, exclude_keywords
    FROM triggers WHERE display_name ILIKE '%aripiprazole%odt%'
  `);

  if (trigger.rows[0]) {
    const t = trigger.rows[0];
    console.log('=== Trigger State ===');
    console.log(`Name: ${t.display_name}`);
    console.log(`Recommended Drug: ${t.recommended_drug}`);
    console.log(`Recommended NDC: ${t.recommended_ndc}`);
    console.log(`Default GP: ${t.default_gp_value}`);
    console.log(`Annual Fills: ${t.annual_fills}`);
    console.log(`Keyword Match: ${t.keyword_match_mode}`);
    console.log(`Detection KW: ${JSON.stringify(t.detection_keywords)}`);
    console.log(`Exclude KW: ${JSON.stringify(t.exclude_keywords)}`);
    console.log(`BIN Inclusions: ${JSON.stringify(t.bin_inclusions)}`);
    console.log(`BIN Exclusions: ${JSON.stringify(t.bin_exclusions)}`);
  }

  // Check current trigger_bin_values for this trigger
  const binVals = await pool.query(`
    SELECT insurance_bin, insurance_group, gp_value, coverage_status, verified_at, best_drug_name, best_ndc
    FROM trigger_bin_values
    WHERE trigger_id = $1
    ORDER BY gp_value DESC NULLS LAST
  `, [trigger.rows[0]?.trigger_id]);

  console.log(`\n=== BIN Values (${binVals.rows.length} entries) ===`);
  for (const r of binVals.rows) {
    console.log(`BIN:${r.insurance_bin} GRP:${r.insurance_group || 'NULL'} | GP:$${r.gp_value} | ${r.coverage_status} | NDC:${r.best_ndc || 'N/A'} | Verified:${r.verified_at}`);
  }

  // Now test what the scan-coverage query would find
  const scanResult = await pool.query(`
    WITH claim_gp AS (
      SELECT
        p.insurance_bin as bin,
        p.insurance_group as group_number,
        p.drug_name,
        p.ndc,
        COALESCE(
          (p.raw_data->>'gross_profit')::numeric,
          (p.raw_data->>'net_profit')::numeric,
          (p.raw_data->>'Gross Profit')::numeric,
          (p.raw_data->>'Net Profit')::numeric
        ) as gp,
        p.quantity_dispensed as qty
      FROM prescriptions p
      WHERE p.dispensed_date >= NOW() - INTERVAL '365 days'
        AND (UPPER(p.drug_name) LIKE '%ARIPIPRAZOLE%' AND UPPER(p.drug_name) LIKE '%ODT%')
        AND p.insurance_bin IS NOT NULL
    ),
    ranked_products AS (
      SELECT
        bin, group_number, drug_name, ndc,
        COUNT(*) as claim_count,
        AVG(gp) as avg_gp,
        AVG(qty) as avg_qty,
        ROW_NUMBER() OVER (
          PARTITION BY bin, group_number
          ORDER BY AVG(gp) DESC
        ) as rank
      FROM claim_gp
      WHERE gp IS NOT NULL
      GROUP BY bin, group_number, drug_name, ndc
      HAVING AVG(gp) >= 10
    )
    SELECT bin, group_number, drug_name, ndc, claim_count,
      ROUND(avg_gp::numeric, 2) as avg_gp, ROUND(avg_qty::numeric, 1) as avg_qty
    FROM ranked_products
    WHERE rank = 1
    ORDER BY avg_gp DESC
  `);

  console.log(`\n=== Simulated scan results (${scanResult.rows.length} BIN/Groups) ===`);
  for (const r of scanResult.rows) {
    console.log(`BIN:${r.bin} GRP:${r.group_number} | ${r.drug_name} | NDC:${r.ndc} | GP:$${r.avg_gp} | claims:${r.claim_count} | avg_qty:${r.avg_qty}`);
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
