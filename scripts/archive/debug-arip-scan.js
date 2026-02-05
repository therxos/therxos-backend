import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Simulate what the scan-coverage endpoint does
  // Check if Parkway claims have dispensed_date set
  const dateCheck = await pool.query(`
    SELECT
      ph.pharmacy_name,
      p.drug_name, p.dispensed_date, p.created_at,
      p.insurance_bin, p.insurance_group
    FROM prescriptions p
    JOIN pharmacies ph ON ph.pharmacy_id = p.pharmacy_id
    WHERE UPPER(p.drug_name) LIKE '%ARIPIPRAZOLE%'
      AND UPPER(p.drug_name) LIKE '%ODT%'
      AND ph.pharmacy_name ILIKE '%parkway%'
    LIMIT 5
  `);
  console.log('=== Parkway Aripiprazole ODT date check ===');
  for (const r of dateCheck.rows) {
    console.log(`${r.pharmacy_name} | ${r.drug_name} | dispensed: ${r.dispensed_date} | created: ${r.created_at} | BIN:${r.insurance_bin} GRP:${r.insurance_group}`);
  }

  // Run the exact same query the scan-coverage would run
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
      GROUP BY bin, group_number, drug_name, ndc
      HAVING AVG(gp) >= 10
    )
    SELECT bin, group_number, drug_name, ndc, claim_count,
      ROUND(avg_gp::numeric, 2) as avg_gp, avg_qty
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
