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

const SKIP_WORDS = ['mg', 'mcg', 'ml', 'tab', 'cap', 'sol', 'cream', 'gel', 'oint', 'susp', 'inj', 'er', 'hcl', 'dr', 'sr', 'xr'];

function getSearchWords(term) {
  return term.split(/[\s,.\-\(\)\[\]]+/)
    .map(w => w.trim().toUpperCase())
    .filter(w => w.length >= 2 && !SKIP_WORDS.includes(w.toLowerCase()) && !/^\d+$/.test(w));
}

async function findDrugs(words) {
  if (words.length === 0) return [];
  const conditions = words.map((w, i) => `POSITION($${i+1} IN UPPER(drug_name)) > 0`);
  const r = await db.query(`
    SELECT DISTINCT UPPER(drug_name) as drug_name, COUNT(*) as cnt,
      AVG(CASE WHEN COALESCE(paid_amount,0) - COALESCE(ingredient_cost,0) - COALESCE(dispensing_fee,0) > 0
        THEN COALESCE(paid_amount,0) - COALESCE(ingredient_cost,0) - COALESCE(dispensing_fee,0) ELSE NULL END) as avg_gp,
      BOOL_OR(insurance_bin IS NOT NULL AND insurance_bin != '') as has_bin
    FROM prescriptions
    WHERE ${conditions.join(' AND ')}
      AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
    GROUP BY UPPER(drug_name)
    ORDER BY cnt DESC LIMIT 10
  `, words);
  return r.rows;
}

async function main() {
  const token = await login(PROD_URL);

  // Get the 19 failing triggers
  const failingNames = [
    'Amlodipine-Atorvastatin (Generic Caduet)',
    'Blood Pressure Monitors (98302-0178-12) [try alternates if NDC doesnt work]',
    'Ceterizine 10mg >  Chewable',
    'Clever Choice Spacer - Simple Diagnostics',
    'Combine Amlodipine + Olmesartan + HCTZ → Tribenzor',
    'Combine Amlodipine + Valsartan + HCTZ → Exforge HCT',
    'Dorzolamide-Timolol Vial > Cosopt PF Generic',
    'DPP4 > Saxagliptin (Generic Onglyza)',
    'GNP Pen Needles ',
    'Insulin Patient without Glucagon/Gvoke',
    'Latanoprost > Travoprost 0.004% (42571-0130-21)',
    'Potassium Liquid - Tablets are Hard to Swallow',
    'Pure Comfort 30g Safety Lancets (No Lancet Device Required)',
    'Risperidone ODT',
    'Sleep Meds > Ramelteon',
    'Switch Sucralafate tablet patients to liquid for ease of taking medicine',
    'Switch Sumatriptin to Rizatriptan ODT for faster acting headache relief',
    'TEST STRIPS',
    'Verifine Lancets (Aetna)',
  ];

  const triggers = await db.query('SELECT * FROM triggers WHERE is_enabled = true ORDER BY display_name');
  const failing = triggers.rows.filter(t => failingNames.includes(t.display_name));

  const fixes = {};

  for (const t of failing) {
    const searchWords = getSearchWords(t.recommended_drug || '');
    const drugs = await findDrugs(searchWords);

    console.log(`\n=== ${t.display_name} ===`);
    console.log(`  recommended_drug: "${t.recommended_drug}"`);
    console.log(`  search words: [${searchWords.join(', ')}]`);
    console.log(`  exclude_keywords: ${JSON.stringify(t.exclude_keywords)}`);
    console.log(`  Matching drugs (${drugs.length}):`);
    drugs.forEach(d => console.log(`    ${d.drug_name} | claims:${d.cnt} | avg_gp:${d.avg_gp ? '$'+parseFloat(d.avg_gp).toFixed(2) : 'N/A'} | has_bin:${d.has_bin}`));

    // Diagnose the issue
    if (drugs.length === 0) {
      // Try alternate search terms
      console.log(`  → No matches. Trying alternates...`);

      // For "HCTZ" triggers, try "HYDROCHLOROTHIAZIDE"
      if (searchWords.includes('HCTZ')) {
        const altWords = searchWords.map(w => w === 'HCTZ' ? 'HYDROCHLOROTHIAZIDE' : w);
        const altDrugs = await findDrugs(altWords);
        if (altDrugs.length > 0) {
          console.log(`  → Found ${altDrugs.length} drugs with HYDROCHLOROTHIAZIDE:`);
          altDrugs.forEach(d => console.log(`    ${d.drug_name} | claims:${d.cnt}`));
          // Fix: change recommended_drug to use full name
          const newRec = t.recommended_drug.replace(/HCTZ/gi, 'Hydrochlorothiazide');
          fixes[t.trigger_id] = { recommendedDrug: newRec, reason: 'HCTZ → Hydrochlorothiazide' };
        }
      }

      // For "PF" in drug name
      if (searchWords.includes('PF')) {
        const altWords = searchWords.filter(w => w !== 'PF');
        const altDrugs = await findDrugs(altWords);
        if (altDrugs.length > 0) {
          console.log(`  → Found ${altDrugs.length} drugs without "PF" filter:`);
          altDrugs.forEach(d => console.log(`    ${d.drug_name} | claims:${d.cnt}`));
          const newRec = t.recommended_drug.replace(/\s*PF\s*/i, ' ').trim();
          fixes[t.trigger_id] = { recommendedDrug: newRec, reason: 'Removed "PF" from search' };
        }
      }

      // For GM/10ML in drug name
      if (searchWords.includes('GM/10ML')) {
        const altWords = searchWords.filter(w => w !== 'GM/10ML');
        const altDrugs = await findDrugs(altWords);
        if (altDrugs.length > 0) {
          console.log(`  → Found ${altDrugs.length} drugs without "GM/10ML" filter:`);
          altDrugs.forEach(d => console.log(`    ${d.drug_name} | claims:${d.cnt}`));
          fixes[t.trigger_id] = { recommendedDrug: altWords.join(' '), reason: 'Simplified search terms' };
        }
      }

      // For Amlodipine-Atorvastatin - check if there are any with just one word
      if (searchWords.includes('ATORVASTATIN') && searchWords.includes('AMLODIPINE')) {
        const r = await db.query(`
          SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as c
          FROM prescriptions
          WHERE (POSITION('AMLODIPINE' IN UPPER(drug_name)) > 0 AND POSITION('ATORVASTATIN' IN UPPER(drug_name)) > 0)
             OR POSITION('CADUET' IN UPPER(drug_name)) > 0
          GROUP BY UPPER(drug_name) ORDER BY c DESC LIMIT 5
        `);
        if (r.rows.length > 0) {
          console.log(`  → Found via broader search:`);
          r.rows.forEach(d => console.log(`    ${d.dn} | claims:${d.c}`));
        } else {
          console.log(`  → No Amlodipine-Atorvastatin or Caduet claims at all`);
        }
      }
    } else {
      // Has matches but scanner didn't find them. Check GP and BIN
      const noGp = drugs.filter(d => !d.avg_gp || parseFloat(d.avg_gp) <= 0);
      const noBin = drugs.filter(d => !d.has_bin);
      if (noGp.length === drugs.length) {
        console.log('  → All matches have GP <= 0 — no profitable claims');
      } else if (noBin.length === drugs.length) {
        console.log('  → All matches missing insurance_bin');
      } else {
        console.log('  → Has good data — should match after exclude fix. May need re-scan.');
      }
    }
  }

  // Apply fixes
  console.log('\n\n====== APPLYING FIXES ======');
  for (const [triggerId, fix] of Object.entries(fixes)) {
    const t = failing.find(t => t.trigger_id === triggerId);
    console.log(`\n${t.display_name}:`);
    console.log(`  Reason: ${fix.reason}`);
    console.log(`  OLD recommended_drug: "${t.recommended_drug}"`);
    console.log(`  NEW recommended_drug: "${fix.recommendedDrug}"`);

    const result = await updateTrigger(token, triggerId, { recommendedDrug: fix.recommendedDrug });
    console.log(result.trigger ? '  ✓ Updated' : `  ✗ FAILED: ${result.error}`);
  }

  console.log(`\nApplied ${Object.keys(fixes).length} fixes`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
