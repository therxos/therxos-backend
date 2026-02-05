import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Show raw vs normalized GP for Aripiprazole ODT
  const result = await pool.query(`
    WITH raw_claims AS (
      SELECT
        p.insurance_bin as bin,
        p.insurance_group as group_number,
        p.drug_name,
        p.ndc,
        p.days_supply,
        p.quantity_dispensed as raw_qty,
        COALESCE(
          (p.raw_data->>'gross_profit')::numeric,
          (p.raw_data->>'net_profit')::numeric,
          (p.raw_data->>'Gross Profit')::numeric,
          (p.raw_data->>'Net Profit')::numeric
        ) as raw_gp,
        COALESCE(
          (p.raw_data->>'gross_profit')::numeric,
          (p.raw_data->>'net_profit')::numeric,
          (p.raw_data->>'Gross Profit')::numeric,
          (p.raw_data->>'Net Profit')::numeric
        ) / GREATEST(CEIL(COALESCE(p.days_supply, 30)::numeric / 30.0), 1) as gp_30day,
        p.quantity_dispensed / GREATEST(CEIL(COALESCE(p.days_supply, 30)::numeric / 30.0), 1) as qty_30day
      FROM prescriptions p
      WHERE p.dispensed_date >= NOW() - INTERVAL '365 days'
        AND (UPPER(p.drug_name) LIKE '%ARIPIPRAZOLE%' AND UPPER(p.drug_name) LIKE '%ODT%')
        AND p.insurance_bin IS NOT NULL
    )
    SELECT bin, group_number, drug_name, ndc,
      COUNT(*) as claims,
      ROUND(AVG(raw_gp)::numeric, 2) as avg_raw_gp,
      ROUND(AVG(gp_30day)::numeric, 2) as avg_30day_gp,
      ROUND(AVG(raw_qty)::numeric, 1) as avg_raw_qty,
      ROUND(AVG(qty_30day)::numeric, 1) as avg_30day_qty,
      ROUND(AVG(days_supply)::numeric, 0) as avg_days_supply
    FROM raw_claims
    WHERE raw_gp IS NOT NULL
    GROUP BY bin, group_number, drug_name, ndc
    HAVING AVG(gp_30day) >= 10
    ORDER BY avg_30day_gp DESC
  `);

  console.log('=== Aripiprazole ODT: Raw GP vs 30-day Normalized ===');
  console.log('BIN        | GROUP     | Raw GP   | 30-day GP | Raw Qty | 30d Qty | Days | Claims');
  console.log('-'.repeat(95));
  for (const r of result.rows) {
    console.log(
      `${r.bin.padEnd(10)} | ${(r.group_number||'').padEnd(9)} | $${String(r.avg_raw_gp).padEnd(8)} | $${String(r.avg_30day_gp).padEnd(9)} | ${String(r.avg_raw_qty).padEnd(7)} | ${String(r.avg_30day_qty).padEnd(7)} | ${String(r.avg_days_supply).padEnd(4)} | ${r.claims}`
    );
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
