import 'dotenv/config';
import db from './src/database/index.js';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';

// UPDATED SKIP_WORDS (removed 'sodium' and 'potassium' — they are real drug ingredients)
const SKIP_WORDS = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with', 'to', 'of'];

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

function getSearchWords(term) {
  return term
    .split(/[\s,.\-\(\)\[\]]+/)
    .map(w => w.trim().toUpperCase())
    .filter(w => w.length >= 2 && !SKIP_WORDS.includes(w.toLowerCase()) && !/^\d+$/.test(w));
}

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

async function getMatchingDrugs(words, excludeKeywords = []) {
  if (words.length === 0) return [];
  const params = [];
  let paramIdx = 1;
  const conditions = words.map(w => {
    params.push(w);
    return `POSITION($${paramIdx++} IN UPPER(drug_name)) > 0`;
  });
  let excludeClause = '';
  if (excludeKeywords && excludeKeywords.length > 0) {
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
    SELECT DISTINCT UPPER(drug_name) as drug_name, COUNT(*) as cnt
    FROM prescriptions
    WHERE (${conditions.join(' AND ')})
      ${excludeClause}
      AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
      AND insurance_bin IS NOT NULL AND insurance_bin != ''
      AND ${GP_SQL} > 0
    GROUP BY UPPER(drug_name)
    ORDER BY cnt DESC LIMIT 15
  `, params);
  return r.rows;
}

async function main() {
  const token = await login(PROD_URL);
  console.log('Fixing all trigger recommended_drug values for accurate matching...\n');

  const triggers = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc,
           exclude_keywords, trigger_type
    FROM triggers WHERE is_enabled = true ORDER BY display_name
  `);

  // Define fixes — key is display_name, value is new recommended_drug
  const fixMap = {
    // Potassium: was "Potassium Liquid" → ["LIQUID"] too generic.
    // With potassium removed from SKIP_WORDS, "Potassium Liquid" → ["POTASSIUM", "LIQUID"] — correct!
    'Potassium Liquid - Tablets are Hard to Swallow': {
      recommendedDrug: 'Potassium Liquid',
      reason: 'Restored "Potassium Liquid" (potassium no longer a skip word → keywords [POTASSIUM, LIQUID])'
    },

    // Comfort Ez Syringes: "Syringe" → ["SYRINGE"] too generic (matches vaccines)
    'Comfort Ez Syringes': {
      recommendedDrug: 'Comfort EZ Syringe',
      reason: '"Syringe" alone matches vaccines. "Comfort EZ Syringe" → [COMFORT, EZ, SYRINGE]'
    },

    // Sucralfate: "Sucralfate" matches tablets + liquid. Trigger wants liquid form for coverage.
    // "Sucralfate 10ml" → ["SUCRALFATE", "10ML"] matches only liquid forms
    'Switch Sucralafate tablet patients to liquid for ease of taking medicine': {
      recommendedDrug: 'Sucralfate 10ml',
      reason: '"Sucralfate" alone matches tablets. "Sucralfate 10ml" → [SUCRALFATE, 10ML] matches only liquid'
    },

    // Pure Comfort Lancets 30g: "Lancet" → ["LANCET"] matches all brands
    // Should be specific to Pure Comfort brand
    'Pure Comfort Lancets 30g ': {
      recommendedDrug: 'Pure Comfort Lancets',
      reason: '"Lancet" matches all brands. "Pure Comfort Lancets" → [PURE, COMFORT, LANCETS]'
    },

    // Pure Comfort 30g Safety Lancets: "Pure Comfort" matches spacers too
    // Add "Lancet" for specificity
    'Pure Comfort 30g Safety Lancets (No Lancet Device Required)': {
      recommendedDrug: 'Pure Comfort 30g Safety Lancet',
      reason: '"Pure Comfort" also matches spacers. Adding "30g Safety Lancet" for specificity'
    },
  };

  let applied = 0;
  for (const t of triggers.rows) {
    const fix = fixMap[t.display_name];
    if (!fix) continue;

    const newWords = getSearchWords(fix.recommendedDrug);
    const drugs = await getMatchingDrugs(newWords, t.exclude_keywords);

    console.log(`FIX: ${t.display_name}`);
    console.log(`  Reason: ${fix.reason}`);
    console.log(`  OLD: "${t.recommended_drug}" → [${getSearchWords(t.recommended_drug || '').join(', ')}]`);
    console.log(`  NEW: "${fix.recommendedDrug}" → [${newWords.join(', ')}]`);
    console.log(`  Matches (${drugs.length}):`);
    drugs.forEach(d => console.log(`    ${d.drug_name} (${d.cnt} claims)`));

    const result = await updateTrigger(token, t.trigger_id, { recommendedDrug: fix.recommendedDrug });
    if (result.trigger || result.success) {
      console.log(`  ✓ Updated`);
      applied++;
    } else {
      console.log(`  ✗ FAILED: ${result.error || JSON.stringify(result)}`);
    }
    console.log('');
  }

  // Now verify ALL triggers with updated SKIP_WORDS
  console.log('\n====== FULL VERIFICATION ======\n');
  const GENERIC_WORDS = new Set(['LIQUID', 'TABLET', 'TABLETS', 'CAPSULE', 'CAPSULES', 'CREAM', 'GEL', 'OINTMENT', 'SPRAY', 'SOLUTION', 'PATCH', 'STRIP', 'STRIPS', 'NEEDLE', 'NEEDLES', 'MONITOR', 'DEVICE', 'PEN', 'SYRINGE', 'SYRINGES', 'VIAL', 'GENERIC', 'BRAND', 'CHEWABLE']);

  // Re-fetch triggers after updates
  const updated = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, exclude_keywords, trigger_type
    FROM triggers WHERE is_enabled = true ORDER BY display_name
  `);

  let passing = 0, failing = 0, warnings = 0;
  for (const t of updated.rows) {
    const words = getSearchWords(t.recommended_drug || '');
    const nonGeneric = words.filter(w => !GENERIC_WORDS.has(w));

    if (words.length === 0) {
      console.log(`  ✗ ${t.display_name} — NO KEYWORDS`);
      failing++;
      continue;
    }

    if (nonGeneric.length === 0) {
      console.log(`  ⚠ ${t.display_name} — ALL GENERIC KEYWORDS: [${words.join(', ')}]`);
      warnings++;
      continue;
    }

    const drugs = await getMatchingDrugs(words, t.exclude_keywords);
    if (drugs.length > 0) {
      // Spot-check: do the drug names look related to the trigger?
      const topDrug = drugs[0].drug_name;
      console.log(`  ✓ ${t.display_name} → ${drugs.length} drugs, top: ${topDrug} (${drugs[0].cnt} claims)`);
      passing++;
    } else {
      console.log(`  ✗ ${t.display_name} — 0 matches [${words.join(', ')}]`);
      failing++;
    }
  }

  console.log(`\nApplied ${applied} fixes`);
  console.log(`FINAL: ${passing} passing, ${failing} failing, ${warnings} warnings out of ${updated.rows.length}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
