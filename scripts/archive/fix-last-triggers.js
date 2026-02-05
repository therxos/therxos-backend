import 'dotenv/config';
import db from './src/database/index.js';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';

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

  // Fix 1: Amlodipine-Atorvastatin — drug name truncated to "ATORVAST" in data
  const t1 = await db.query("SELECT * FROM triggers WHERE display_name = 'Amlodipine-Atorvastatin (Generic Caduet)' AND is_enabled = true");
  if (t1.rows.length > 0) {
    const trigger = t1.rows[0];
    console.log(`Fixing: ${trigger.display_name}`);
    console.log(`  OLD recommended_drug: "${trigger.recommended_drug}"`);
    console.log(`  NEW recommended_drug: "Amlodipine-Atorvast"`);

    const result = await updateTrigger(token, trigger.trigger_id, {
      recommendedDrug: 'Amlodipine-Atorvast'
    });
    console.log(result.trigger ? '  ✓ Updated' : `  ✗ FAILED: ${result.error}`);
  }

  // Verify Sucralfate exclude_keywords don't self-exclude the new recommended_drug "Sucralfate"
  const t2 = await db.query("SELECT * FROM triggers WHERE display_name LIKE '%Sucralafate%' OR display_name LIKE '%Sucralfate%'");
  for (const t of t2.rows) {
    console.log(`\nVerifying: ${t.display_name}`);
    console.log(`  recommended_drug: "${t.recommended_drug}"`);
    console.log(`  exclude_keywords: ${JSON.stringify(t.exclude_keywords)}`);
    // Check if "SUSP" or "SUSPENSION" appears in "SUCRALFATE" — it doesn't, so we're fine
    const recUpper = (t.recommended_drug || '').toUpperCase();
    for (const ekw of (t.exclude_keywords || [])) {
      if (recUpper.includes(ekw.toUpperCase())) {
        console.log(`  ⚠ SELF-EXCLUDE: "${ekw}" is in "${t.recommended_drug}"`);
      } else {
        console.log(`  ✓ "${ekw}" does NOT appear in "${t.recommended_drug}"`);
      }
    }
  }

  // Now verify ALL triggers match by running same logic as coverage scanner
  console.log('\n\n====== FINAL VERIFICATION ======');
  const SKIP_WORDS = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with', 'to', 'of'];
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
  const DAYS_SUPPLY_EST = `COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END)`;

  const triggers = await db.query("SELECT * FROM triggers WHERE is_enabled = true ORDER BY display_name");
  let passing = 0, failing = 0;

  for (const t of triggers.rows) {
    const searchTerm = t.recommended_drug || '';
    const words = searchTerm
      .split(/[\s,.\-\(\)\[\]]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length >= 2 && !SKIP_WORDS.includes(w.toLowerCase()) && !/^\d+$/.test(w));

    if (words.length === 0) {
      console.log(`  ✗ ${t.display_name} — no search keywords`);
      failing++;
      continue;
    }

    const params = [];
    let paramIdx = 1;
    const conditions = words.map(w => {
      params.push(w);
      return `POSITION($${paramIdx++} IN UPPER(drug_name)) > 0`;
    });

    // Build exclude conditions
    let excludeClause = '';
    const excludeKeywords = t.exclude_keywords || [];
    if (excludeKeywords.length > 0) {
      const excludeParts = excludeKeywords.map(kw => {
        const eWords = kw.split(/[\s,.\-\(\)\[\]]+/)
          .map(w => w.trim().toUpperCase())
          .filter(w => w.length >= 2);
        if (eWords.length === 0) return null;
        return '(' + eWords.map(word => {
          params.push(word);
          return `POSITION($${paramIdx++} IN UPPER(drug_name)) > 0`;
        }).join(' AND ') + ')';
      }).filter(Boolean);
      if (excludeParts.length > 0) {
        excludeClause = `AND NOT (${excludeParts.join(' OR ')})`;
      }
    }

    const r = await db.query(`
      SELECT COUNT(*) as cnt
      FROM prescriptions
      WHERE (${conditions.join(' AND ')})
        ${excludeClause}
        AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
        AND ${DAYS_SUPPLY_EST} >= 28
        AND ${GP_SQL} > 0
        AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '365 days'
    `, params);

    const count = parseInt(r.rows[0].cnt);
    if (count > 0) {
      console.log(`  ✓ ${t.display_name} — ${count} qualifying claims`);
      passing++;
    } else {
      console.log(`  ✗ ${t.display_name} — 0 qualifying claims [${words.join(', ')}] excl:${JSON.stringify(excludeKeywords)}`);
      failing++;
    }
  }

  console.log(`\nFINAL: ${passing} passing, ${failing} failing out of ${triggers.rows.length} triggers`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
