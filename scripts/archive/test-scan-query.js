import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  try {
    // Test the exact query pattern from the coverage scan
    const r = await pool.query(`
      WITH raw_claims AS (
        SELECT
          insurance_bin as bin,
          insurance_group as grp,
          drug_name,
          ndc,
          COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0)
            / GREATEST(CEIL(COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END)::numeric / 30.0), 1) as gp_30day,
          COALESCE(quantity_dispensed, 1)
            / GREATEST(CEIL(COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END)::numeric / 30.0), 1) as qty_30day,
          dispensed_date, created_at
        FROM prescriptions
        WHERE UPPER(drug_name) LIKE '%CYCLOSPORINE%'
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
        AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '365 days'
      )
      SELECT bin, COUNT(*) as cnt, AVG(gp_30day) as avg_gp, AVG(qty_30day) as avg_qty
      FROM raw_claims
      GROUP BY bin
      LIMIT 5
    `);
    console.log('Query works. Results:', r.rows);
  } catch (e) {
    console.error('Query failed:', e.message);
    console.error('Detail:', e.detail);
    console.error('Position:', e.position);
  }
  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
