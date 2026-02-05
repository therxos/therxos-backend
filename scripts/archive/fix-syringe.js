import 'dotenv/config';
import db from './src/database/index.js';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';
const GP_SQL = `COALESCE(
  NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'grossprofit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'GrossProfit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Net Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'netprofit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'NetProfit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'adj_profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Adj Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'adjprofit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'AdjProfit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'adjusted_profit', ',', '')::numeric, 0),
  NULLIF(
    REPLACE(REPLACE(COALESCE(raw_data->>'Price','0'), '$', ''), ',', '')::numeric
    - REPLACE(REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', ''), ',', '')::numeric,
  0)
)`;

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  return (await res.json()).token;
}

async function updateTrigger(token, id, updates) {
  const res = await fetch(`${PROD_URL}/api/admin/triggers/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  return res.json();
}

async function main() {
  const token = await login(PROD_URL);

  // Fix Comfort Ez Syringes: products are "COMFORT EZ SYR" not "COMFORT EZ SYRINGE"
  const t = await db.query("SELECT * FROM triggers WHERE display_name = 'Comfort Ez Syringes' AND is_enabled = true");
  if (t.rows.length > 0) {
    // Use "Comfort EZ SYR" → keywords [COMFORT, EZ, SYR]
    const result = await updateTrigger(token, t.rows[0].trigger_id, {
      recommendedDrug: 'Comfort EZ SYR'
    });
    console.log(result.trigger ? '✓ Updated Comfort Ez Syringes → "Comfort EZ SYR"' : `✗ FAILED: ${result.error}`);

    // Verify
    const check = await db.query(`
      SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
      FROM prescriptions
      WHERE POSITION('COMFORT' IN UPPER(drug_name)) > 0
        AND POSITION('EZ' IN UPPER(drug_name)) > 0
        AND POSITION('SYR' IN UPPER(drug_name)) > 0
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
        AND ${GP_SQL} > 0
      GROUP BY UPPER(drug_name) ORDER BY cnt DESC
    `);
    console.log('Matches:');
    check.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
