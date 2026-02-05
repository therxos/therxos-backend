import 'dotenv/config';
import db from './src/database/index.js';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';

// Exact SKIP_WORDS from coverage-scanner.js
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

// Get matching drug names for keywords
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
  console.log('Auditing ALL triggers for correct drug matching...\n');

  const triggers = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc,
           detection_keywords, exclude_keywords, trigger_type, is_enabled
    FROM triggers WHERE is_enabled = true ORDER BY display_name
  `);

  const issues = [];
  const fixes = [];

  for (const t of triggers.rows) {
    const rec = t.recommended_drug || '';
    const words = getSearchWords(rec);

    console.log(`--- ${t.display_name} ---`);
    console.log(`  recommended_drug: "${rec}"`);
    console.log(`  scanner keywords: [${words.join(', ')}]`);

    if (words.length === 0) {
      console.log(`  ⚠ NO KEYWORDS — scanner will skip this trigger entirely`);
      issues.push({ trigger: t, issue: 'no_keywords', desc: 'No searchable keywords after SKIP_WORDS filter' });
      continue;
    }

    // Check if keywords are too generic (single common word)
    const GENERIC_WORDS = ['LIQUID', 'TABLET', 'TABLETS', 'CAPSULE', 'CAPSULES', 'CREAM', 'GEL', 'OINTMENT', 'SPRAY', 'SOLUTION', 'PATCH', 'STRIP', 'STRIPS', 'NEEDLE', 'NEEDLES', 'MONITOR', 'DEVICE', 'PEN', 'SYRINGE', 'SYRINGES', 'VIAL', 'GENERIC', 'BRAND', 'CHEWABLE'];
    const nonGenericWords = words.filter(w => !GENERIC_WORDS.includes(w));

    if (nonGenericWords.length === 0) {
      console.log(`  ⚠ ALL KEYWORDS ARE GENERIC — will match unrelated drugs`);
      issues.push({ trigger: t, issue: 'too_generic', desc: `Only generic keywords: [${words.join(', ')}]` });
    }

    // Get the actual matching drugs
    const drugs = await getMatchingDrugs(words, t.exclude_keywords);
    if (drugs.length > 0) {
      console.log(`  Matching drugs (${drugs.length}):`);
      drugs.forEach(d => console.log(`    ${d.drug_name} (${d.cnt} claims)`));

      // Check if any matched drug seems unrelated to the trigger
      const triggerDrugWords = rec.toUpperCase().split(/[\s,.\-\(\)\[\]]+/).filter(w => w.length >= 3);
      const unrelated = drugs.filter(d => {
        // If the drug name doesn't share any 4+ char word with the recommended_drug, it might be unrelated
        const drugWords = d.drug_name.split(/[\s,.\-\(\)\[\]]+/).filter(w => w.length >= 4);
        return !drugWords.some(dw => triggerDrugWords.some(tw => dw.includes(tw) || tw.includes(dw)));
      });
      if (unrelated.length > 0) {
        console.log(`  ⚠ POTENTIALLY UNRELATED MATCHES:`);
        unrelated.forEach(d => console.log(`    !! ${d.drug_name} (${d.cnt} claims)`));
        issues.push({ trigger: t, issue: 'unrelated_matches', desc: `Matches unrelated: ${unrelated.map(d => d.drug_name).join(', ')}` });
      }
    } else {
      console.log(`  (no matches)`);
      issues.push({ trigger: t, issue: 'no_matches', desc: 'Zero drug matches' });
    }
    console.log('');
  }

  // Print summary of issues
  console.log('\n====== ISSUES FOUND ======\n');
  for (const i of issues) {
    console.log(`${i.issue}: ${i.trigger.display_name}`);
    console.log(`  ${i.desc}`);
    console.log(`  recommended_drug: "${i.trigger.recommended_drug}"`);
    console.log(`  keywords: [${getSearchWords(i.trigger.recommended_drug || '').join(', ')}]`);
    console.log('');
  }

  // Auto-fix known issues
  console.log('\n====== AUTO-FIXES ======\n');

  for (const i of issues) {
    const t = i.trigger;
    let newRec = null;
    let reason = '';

    if (i.issue === 'no_keywords') {
      // The recommended_drug text gets entirely filtered out by SKIP_WORDS
      // Need to change to a more specific drug name
      const rec = (t.recommended_drug || '').toUpperCase();

      // Potassium — "POTASSIUM" is a skip word
      if (rec.includes('POTASSIUM')) {
        newRec = 'Potassium Chloride';
        reason = '"Potassium" is in SKIP_WORDS; "Potassium Chloride" keeps "CHLORIDE" as searchable keyword';
      }
    }

    if (i.issue === 'too_generic') {
      const words = getSearchWords(t.recommended_drug || '');
      const rec = (t.recommended_drug || '').toUpperCase();

      // Potassium Liquid → only keyword is LIQUID
      if (words.length === 1 && words[0] === 'LIQUID' && rec.includes('POTASSIUM')) {
        newRec = 'Potassium Chloride';
        reason = '"Potassium" is skip word, "Liquid" too generic → use "Potassium Chloride"';
      }
    }

    if (i.issue === 'unrelated_matches') {
      // Check specific known cases
      const words = getSearchWords(t.recommended_drug || '');
      const rec = (t.recommended_drug || '').toUpperCase();

      // If matching is too broad due to generic word, try adding specificity
      if (words.includes('LIQUID') && !words.some(w => !['LIQUID', 'TABLET', 'CHEWABLE', 'STRIP', 'STRIPS'].includes(w))) {
        if (rec.includes('POTASSIUM')) {
          newRec = 'Potassium Chloride';
          reason = 'Too generic matching (LIQUID matches Salicylic Acid etc.)';
        }
      }
    }

    if (newRec) {
      console.log(`FIX: ${t.display_name}`);
      console.log(`  OLD: "${t.recommended_drug}" → keywords: [${getSearchWords(t.recommended_drug || '').join(', ')}]`);
      console.log(`  NEW: "${newRec}" → keywords: [${getSearchWords(newRec).join(', ')}]`);

      // Verify the new keywords match the right drugs
      const newWords = getSearchWords(newRec);
      const newDrugs = await getMatchingDrugs(newWords, t.exclude_keywords);
      console.log(`  New matches (${newDrugs.length}):`);
      newDrugs.forEach(d => console.log(`    ${d.drug_name} (${d.cnt} claims)`));

      // Apply fix
      const result = await updateTrigger(token, t.trigger_id, { recommendedDrug: newRec });
      console.log(result.trigger ? '  ✓ Updated' : `  ✗ FAILED: ${result.error}`);
      fixes.push({ trigger: t, newRec, reason });
      console.log('');
    }
  }

  console.log(`\nTotal issues: ${issues.length}, Auto-fixed: ${fixes.length}`);
  console.log(`Remaining issues needing review: ${issues.length - fixes.length}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
