import 'dotenv/config';
import db from './src/database/index.js';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';

// Exact same SKIP_WORDS as coverage-scanner.js
const SKIP_WORDS = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with', 'to', 'of'];

// Exact same GP_SQL as coverage-scanner.js
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

// Test if keywords find matches in prescriptions (exactly like coverage scanner)
async function testKeywords(words, excludeKeywords = []) {
  if (words.length === 0) return { matches: [], reason: 'no keywords' };

  const params = [];
  let paramIdx = 1;
  const conditions = words.map(w => {
    params.push(w);
    return `POSITION($${paramIdx++} IN UPPER(drug_name)) > 0`;
  });

  // Build exclude conditions
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
    SELECT DISTINCT UPPER(drug_name) as drug_name, COUNT(*) as cnt,
      SUM(CASE WHEN ${GP_SQL} > 0 THEN 1 ELSE 0 END) as gp_claims,
      BOOL_OR(insurance_bin IS NOT NULL AND insurance_bin != '') as has_bin
    FROM prescriptions
    WHERE (${conditions.join(' AND ')})
      ${excludeClause}
      AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
    GROUP BY UPPER(drug_name)
    ORDER BY cnt DESC LIMIT 15
  `, params);

  return { matches: r.rows };
}

// Test with coverage scanner's exact filtering (GP > 0, BIN present, days >= 28)
async function testCoverageMatch(words, excludeKeywords = []) {
  if (words.length === 0) return { matches: [] };

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
    SELECT insurance_bin, COALESCE(insurance_group, '') as insurance_group,
      COUNT(*) as claim_count,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ${GP_SQL} / GREATEST(CEIL(${DAYS_SUPPLY_EST}::numeric / 30.0), 1)) as median_gp
    FROM prescriptions
    WHERE (${conditions.join(' AND ')})
      ${excludeClause}
      AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
      AND insurance_bin IS NOT NULL AND insurance_bin != ''
      AND ${DAYS_SUPPLY_EST} >= 28
      AND ${GP_SQL} > 0
      AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '365 days'
    GROUP BY insurance_bin, COALESCE(insurance_group, '')
    HAVING COUNT(*) >= 1
    ORDER BY median_gp DESC
    LIMIT 10
  `, params);

  return { matches: r.rows };
}

async function main() {
  const token = await login(PROD_URL);
  console.log('Logged in.\n');

  const triggers = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc,
           detection_keywords, exclude_keywords, trigger_type, is_enabled
    FROM triggers WHERE is_enabled = true ORDER BY display_name
  `);

  console.log(`Evaluating ${triggers.rows.length} enabled triggers...\n`);

  const failing = [];
  const passing = [];

  for (const t of triggers.rows) {
    const searchTerm = t.recommended_drug || '';
    const words = searchTerm ? getSearchWords(searchTerm) : [];

    if (words.length === 0) {
      failing.push({ trigger: t, words, reason: 'no search words' });
      continue;
    }

    const coverage = await testCoverageMatch(words, t.exclude_keywords);
    if (coverage.matches.length > 0) {
      passing.push(t.display_name);
    } else {
      // Check if there are claims at all (without coverage scanner filters)
      const basic = await testKeywords(words, t.exclude_keywords);
      failing.push({ trigger: t, words, reason: 'no coverage matches', basicMatches: basic.matches });
    }
  }

  console.log(`PASSING: ${passing.length} triggers have coverage matches`);
  passing.forEach(n => console.log(`  ✓ ${n}`));

  console.log(`\nFAILING: ${failing.length} triggers have NO coverage matches`);
  failing.forEach(f => console.log(`  ✗ ${f.trigger.display_name} — ${f.reason}`));

  // Now diagnose and fix each failing trigger
  console.log('\n\n====== DIAGNOSING AND FIXING ======\n');

  const fixes = [];

  for (const f of failing) {
    const t = f.trigger;
    console.log(`\n--- ${t.display_name} ---`);
    console.log(`  recommended_drug: "${t.recommended_drug}"`);
    console.log(`  keywords extracted: [${f.words.join(', ')}]`);
    console.log(`  exclude_keywords: ${JSON.stringify(t.exclude_keywords)}`);
    console.log(`  trigger_type: ${t.trigger_type}`);

    if (f.basicMatches && f.basicMatches.length > 0) {
      console.log(`  Basic matches (without coverage filters):`);
      f.basicMatches.forEach(m => console.log(`    ${m.drug_name} | claims:${m.cnt} | gp_claims:${m.gp_claims} | has_bin:${m.has_bin}`));
    }

    // Strategy: try to find a simpler recommended_drug that produces coverage matches
    // The recommended_drug should be JUST the drug name, not a description

    // For triggers where recommended_drug contains non-drug words, extract just the drug name
    let newRecommendedDrug = null;
    let reason = '';

    // Specific known fixes based on common patterns
    const name = t.display_name;
    const rec = (t.recommended_drug || '').toUpperCase();

    // 1. HCTZ → HYDROCHLOROTHIAZIDE
    if (f.words.includes('HCTZ')) {
      const altWords = f.words.map(w => w === 'HCTZ' ? 'HYDROCHLOROTHIAZIDE' : w);
      const altCoverage = await testCoverageMatch(altWords, t.exclude_keywords);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = t.recommended_drug.replace(/HCTZ/gi, 'Hydrochlorothiazide');
        reason = 'HCTZ → Hydrochlorothiazide';
        console.log(`  → FIX: Replace HCTZ with Hydrochlorothiazide (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 2. Remove "PF" (preservative-free) from search — not in drug names
    if (!newRecommendedDrug && f.words.includes('PF')) {
      const altWords = f.words.filter(w => w !== 'PF');
      if (altWords.length > 0) {
        const altCoverage = await testCoverageMatch(altWords, t.exclude_keywords);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = t.recommended_drug.replace(/\bPF\b/gi, '').replace(/\s+/g, ' ').trim();
          reason = 'Removed "PF" (not in drug names)';
          console.log(`  → FIX: Remove PF (${altCoverage.matches.length} BIN matches)`);
        }
      }
    }

    // 3. Remove "ODT" from search if not finding matches (or keep if matches exist)
    if (!newRecommendedDrug && f.words.includes('ODT')) {
      const altWords = f.words.filter(w => w !== 'ODT');
      if (altWords.length > 0) {
        const altCoverage = await testCoverageMatch(altWords, t.exclude_keywords);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = t.recommended_drug.replace(/\bODT\b/gi, '').replace(/\s+/g, ' ').trim();
          reason = 'Removed "ODT" (not in most drug names)';
          console.log(`  → FIX: Remove ODT (${altCoverage.matches.length} BIN matches)`);
        }
      }
    }

    // 4. For combo drugs like "Amlodipine-Atorvastatin" — try just the combo name
    if (!newRecommendedDrug && name.includes('Amlodipine-Atorvastatin')) {
      // Try searching for "AMLODIPINE" AND "ATORVASTATIN" together
      const altWords = ['AMLODIPINE', 'ATORVASTATIN'];
      const altCoverage = await testCoverageMatch(altWords, t.exclude_keywords);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Amlodipine-Atorvastatin';
        reason = 'Simplified to combo drug name';
        console.log(`  → FIX: Use "Amlodipine-Atorvastatin" (${altCoverage.matches.length} BIN matches)`);
      } else {
        // Also try just "CADUET"
        const caduetCoverage = await testCoverageMatch(['CADUET'], []);
        if (caduetCoverage.matches.length > 0) {
          newRecommendedDrug = 'Caduet';
          reason = 'Simplified to brand name Caduet';
          console.log(`  → FIX: Use "Caduet" (${caduetCoverage.matches.length} BIN matches)`);
        }
      }
    }

    // 5. Tribenzor combo: need to search for AMLODIPINE + OLMESARTAN + HYDROCHLOROTHIAZIDE
    if (!newRecommendedDrug && name.includes('Tribenzor')) {
      // Try just "TRIBENZOR"
      let altCoverage = await testCoverageMatch(['TRIBENZOR'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Tribenzor';
        reason = 'Use brand name Tribenzor';
        console.log(`  → FIX: Use "Tribenzor" (${altCoverage.matches.length} BIN matches)`);
      } else {
        // Try AMLODIPINE + OLMESARTAN + HYDROCHLOROTHIAZIDE
        altCoverage = await testCoverageMatch(['AMLODIPINE', 'OLMESARTAN', 'HYDROCHLOROTHIAZIDE'], []);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = 'Amlodipine-Olmesartan-Hydrochlorothiazide';
          reason = 'Expanded HCTZ and used generic combo name';
          console.log(`  → FIX: Use generic combo name (${altCoverage.matches.length} BIN matches)`);
        } else {
          // Try AMLODIPINE + OLMESARTAN
          altCoverage = await testCoverageMatch(['AMLODIPINE', 'OLMESARTAN'], []);
          if (altCoverage.matches.length > 0) {
            newRecommendedDrug = 'Amlodipine-Olmesartan';
            reason = 'Use partial combo name (2 of 3 ingredients)';
            console.log(`  → FIX: Use "Amlodipine-Olmesartan" (${altCoverage.matches.length} BIN matches)`);
          }
        }
      }
    }

    // 6. Exforge HCT combo: AMLODIPINE + VALSARTAN + HYDROCHLOROTHIAZIDE
    if (!newRecommendedDrug && name.includes('Exforge')) {
      let altCoverage = await testCoverageMatch(['EXFORGE'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Exforge HCT';
        reason = 'Use brand name Exforge';
        console.log(`  → FIX: Use "Exforge" (${altCoverage.matches.length} BIN matches)`);
      } else {
        altCoverage = await testCoverageMatch(['AMLODIPINE', 'VALSARTAN', 'HYDROCHLOROTHIAZIDE'], []);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = 'Amlodipine-Valsartan-Hydrochlorothiazide';
          reason = 'Expanded HCTZ and used generic combo name';
          console.log(`  → FIX: Use generic combo name (${altCoverage.matches.length} BIN matches)`);
        } else {
          altCoverage = await testCoverageMatch(['AMLODIPINE', 'VALSARTAN'], []);
          if (altCoverage.matches.length > 0) {
            newRecommendedDrug = 'Amlodipine-Valsartan';
            reason = 'Use partial combo name (2 of 3 ingredients)';
            console.log(`  → FIX: Use "Amlodipine-Valsartan" (${altCoverage.matches.length} BIN matches)`);
          }
        }
      }
    }

    // 7. "DPP4 > Saxagliptin" — DPP4 is a class, not in drug names. Use just Saxagliptin
    if (!newRecommendedDrug && f.words.includes('DPP4')) {
      const altWords = f.words.filter(w => w !== 'DPP4');
      if (altWords.length > 0) {
        const altCoverage = await testCoverageMatch(altWords, t.exclude_keywords);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = altWords.join(' ');
          reason = 'Removed "DPP4" (drug class, not in drug names)';
          console.log(`  → FIX: Remove DPP4 (${altCoverage.matches.length} BIN matches)`);
        }
      }
    }

    // 8. "Insulin Patient without Glucagon/Gvoke" — "PATIENT", "WITHOUT" are not drug words
    if (!newRecommendedDrug && (f.words.includes('PATIENT') || f.words.includes('WITHOUT'))) {
      // Try just drug-like words
      const drugWords = f.words.filter(w => !['PATIENT', 'WITHOUT', 'PATIENTS', 'INSULIN'].includes(w));
      if (drugWords.length > 0) {
        const altCoverage = await testCoverageMatch(drugWords, t.exclude_keywords);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = drugWords.join(' ');
          reason = 'Extracted drug name only (removed non-drug words)';
          console.log(`  → FIX: Use "${drugWords.join(' ')}" (${altCoverage.matches.length} BIN matches)`);
        }
      }
      // Try GLUCAGON alone
      if (!newRecommendedDrug) {
        const altCoverage = await testCoverageMatch(['GLUCAGON'], []);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = 'Glucagon';
          reason = 'Use just "Glucagon"';
          console.log(`  → FIX: Use "Glucagon" (${altCoverage.matches.length} BIN matches)`);
        }
      }
      // Try GVOKE
      if (!newRecommendedDrug) {
        const altCoverage = await testCoverageMatch(['GVOKE'], []);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = 'Gvoke';
          reason = 'Use just "Gvoke"';
          console.log(`  → FIX: Use "Gvoke" (${altCoverage.matches.length} BIN matches)`);
        }
      }
    }

    // 9. "Sleep Meds > Ramelteon" — "SLEEP", "MEDS" are not drug names
    if (!newRecommendedDrug && (f.words.includes('SLEEP') || f.words.includes('MEDS'))) {
      const drugWords = f.words.filter(w => !['SLEEP', 'MEDS'].includes(w));
      if (drugWords.length > 0) {
        const altCoverage = await testCoverageMatch(drugWords, t.exclude_keywords);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = drugWords.join(' ');
          reason = 'Removed "Sleep Meds" (not drug names)';
          console.log(`  → FIX: Use "${drugWords.join(' ')}" (${altCoverage.matches.length} BIN matches)`);
        }
      }
    }

    // 10. "Switch X to Y" patterns — "SWITCH" is not a drug name
    if (!newRecommendedDrug && f.words.includes('SWITCH')) {
      const drugWords = f.words.filter(w => !['SWITCH', 'TABLET', 'TABLETS', 'LIQUID', 'FASTER', 'ACTING', 'HEADACHE', 'RELIEF', 'EASE', 'TAKING', 'MEDICINE', 'HARD', 'SWALLOW'].includes(w));
      if (drugWords.length > 0) {
        const altCoverage = await testCoverageMatch(drugWords, t.exclude_keywords);
        if (altCoverage.matches.length > 0) {
          newRecommendedDrug = drugWords.join(' ');
          reason = 'Extracted drug names from sentence';
          console.log(`  → FIX: Use "${drugWords.join(' ')}" (${altCoverage.matches.length} BIN matches)`);
        } else {
          // Try each drug word individually
          for (const w of drugWords) {
            const singleCoverage = await testCoverageMatch([w], t.exclude_keywords);
            if (singleCoverage.matches.length > 0) {
              newRecommendedDrug = w.charAt(0) + w.slice(1).toLowerCase();
              reason = `Extracted just "${w}" from sentence`;
              console.log(`  → FIX: Use "${newRecommendedDrug}" (${singleCoverage.matches.length} BIN matches)`);
              break;
            }
          }
        }
      }
    }

    // 11. For "Sucralafate" style — remove non-drug words
    if (!newRecommendedDrug && name.includes('Sucra')) {
      const altCoverage = await testCoverageMatch(['SUCRALFATE'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Sucralfate';
        reason = 'Use just drug name "Sucralfate"';
        console.log(`  → FIX: Use "Sucralfate" (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 12. "Sumatriptan to Rizatriptan" — try just the recommended drug
    if (!newRecommendedDrug && (f.words.includes('SUMATRIPTIN') || f.words.includes('SUMATRIPTAN') || f.words.includes('RIZATRIPTAN'))) {
      const altCoverage = await testCoverageMatch(['RIZATRIPTAN'], t.exclude_keywords);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Rizatriptan';
        reason = 'Use just recommended drug "Rizatriptan"';
        console.log(`  → FIX: Use "Rizatriptan" (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 13. "Latanoprost > Travoprost" — search only for the recommended one
    if (!newRecommendedDrug && f.words.includes('LATANOPROST') && f.words.includes('TRAVOPROST')) {
      const altCoverage = await testCoverageMatch(['TRAVOPROST'], t.exclude_keywords);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Travoprost';
        reason = 'Search only for recommended drug Travoprost (not current drug Latanoprost)';
        console.log(`  → FIX: Use "Travoprost" (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 14. "Cetirizine" (note: trigger has "Ceterizine" misspelling)
    if (!newRecommendedDrug && (name.includes('Ceterizine') || name.includes('Cetirizine'))) {
      // Try correct spelling
      const altCoverage = await testCoverageMatch(['CETIRIZINE'], t.exclude_keywords);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Cetirizine Chewable';
        reason = 'Fixed spelling: Ceterizine → Cetirizine';
        console.log(`  → FIX: Fix spelling to "Cetirizine" (${altCoverage.matches.length} BIN matches)`);
      } else {
        // Try with chewable
        const altCoverage2 = await testCoverageMatch(['CETIRIZINE', 'CHEW'], []);
        if (altCoverage2.matches.length > 0) {
          newRecommendedDrug = 'Cetirizine Chewable';
          reason = 'Fixed spelling and added Chewable';
          console.log(`  → FIX: Use "Cetirizine Chewable" (${altCoverage2.matches.length} BIN matches)`);
        }
      }
    }

    // 15. "Potassium Liquid" — "POTASSIUM" is in SKIP_WORDS! This would produce 0 keywords in coverage scanner
    if (!newRecommendedDrug && name.includes('Potassium')) {
      // The issue: coverage-scanner SKIP_WORDS includes "potassium"!
      // Need a more specific drug name
      const altCoverage = await testCoverageMatch(['POTASSIUM', 'CHLORIDE', 'LIQUID'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Potassium Chloride Liquid';
        reason = 'Added "Chloride" and "Liquid" (potassium alone is a skip word)';
        console.log(`  → FIX: Use "Potassium Chloride Liquid" (${altCoverage.matches.length} BIN matches)`);
      } else {
        // Try just potassium chloride
        const altCoverage2 = await testCoverageMatch(['POTASSIUM', 'CHLORIDE'], []);
        if (altCoverage2.matches.length > 0) {
          newRecommendedDrug = 'Potassium Chloride';
          reason = 'Added "Chloride" (potassium alone is a skip word in scanner)';
          console.log(`  → FIX: Use "Potassium Chloride" (${altCoverage2.matches.length} BIN matches)`);
        }
      }
      // Wait — POTASSIUM is a skip word, so the scanner would SKIP it. Let me check what words actually get through
      const actualScannerWords = getSearchWords(t.recommended_drug || '');
      console.log(`  Scanner actual keywords: [${actualScannerWords.join(', ')}]`);
      if (actualScannerWords.length === 0 || (actualScannerWords.length === 1 && actualScannerWords[0] === 'LIQUID')) {
        // "Potassium Liquid" → scanner gets just ["LIQUID"] which is too generic, or nothing
        // Fix: use "Potassium Chloride" — "CHLORIDE" is not a skip word
        const altCoverage3 = await testCoverageMatch(['CHLORIDE'], []);
        if (altCoverage3.matches.length > 0) {
          newRecommendedDrug = 'Potassium Chloride';
          reason = '"Potassium" is a skip word in scanner; use "Potassium Chloride" so "CHLORIDE" is searchable';
          console.log(`  → FIX: Use "Potassium Chloride" (CHLORIDE not a skip word) (${altCoverage3.matches.length} BIN matches)`);
        }
      }
    }

    // 16. TEST STRIPS — too generic, try "TEST STRIP" (note: might be same as existing passing trigger)
    if (!newRecommendedDrug && name === 'TEST STRIPS') {
      const altCoverage = await testCoverageMatch(['TEST', 'STRIP'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Test Strip';
        reason = 'Simplified to "Test Strip"';
        console.log(`  → FIX: Use "Test Strip" (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 17. Blood Pressure Monitors — DME, try specific product search
    if (!newRecommendedDrug && name.includes('Blood Pressure Monitor')) {
      const altCoverage = await testCoverageMatch(['BLOOD', 'PRESSURE'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Blood Pressure Monitor';
        reason = 'Simplified search';
        console.log(`  → FIX: Use "Blood Pressure Monitor" (${altCoverage.matches.length} BIN matches)`);
      } else {
        // Try just "MONITOR"
        const altCoverage2 = await testCoverageMatch(['MONITOR'], []);
        if (altCoverage2.matches.length > 0) {
          newRecommendedDrug = 'Monitor';
          reason = 'Use just "Monitor"';
          console.log(`  → FIX: Use "Monitor" (${altCoverage2.matches.length} BIN matches)`);
        }
      }
    }

    // 18. Clever Choice Spacer — DME product
    if (!newRecommendedDrug && name.includes('Clever Choice Spacer')) {
      const altCoverage = await testCoverageMatch(['SPACER'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Spacer';
        reason = 'Use generic "Spacer"';
        console.log(`  → FIX: Use "Spacer" (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 19. GNP Pen Needles — try just "PEN NEEDLES" or "PEN NEEDLE"
    if (!newRecommendedDrug && name.includes('GNP Pen Needles')) {
      const altCoverage = await testCoverageMatch(['PEN', 'NEEDLE'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'GNP Pen Needles';
        reason = 'Keep current (PEN NEEDLE matches)';
        console.log(`  → FIX: Keep as is (${altCoverage.matches.length} BIN matches)`);
      } else {
        const altCoverage2 = await testCoverageMatch(['NEEDLE'], []);
        if (altCoverage2.matches.length > 0) {
          newRecommendedDrug = 'Pen Needles';
          reason = 'Simplified to "Pen Needles"';
          console.log(`  → FIX: Use "Pen Needles" (${altCoverage2.matches.length} BIN matches)`);
        }
      }
    }

    // 20. Pure Comfort Lancets
    if (!newRecommendedDrug && name.includes('Pure Comfort')) {
      const altCoverage = await testCoverageMatch(['LANCET'], []);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Safety Lancets';
        reason = 'Simplified to "Safety Lancets"';
        console.log(`  → FIX: Use "Lancets" (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 21. Verifine Lancets — user said this one might genuinely have no claims
    if (!newRecommendedDrug && name.includes('Verifine')) {
      console.log(`  → SKIP: User noted Verifine may have no paid claims`);
      continue;
    }

    // 22. Dorzolamide-Timolol (if PF fix above didn't work)
    if (!newRecommendedDrug && name.includes('Dorzolamide') && name.includes('Timolol')) {
      const altCoverage = await testCoverageMatch(['DORZOLAMIDE', 'TIMOLOL'], t.exclude_keywords);
      if (altCoverage.matches.length > 0) {
        newRecommendedDrug = 'Dorzolamide-Timolol';
        reason = 'Use just "Dorzolamide-Timolol" without PF/Vial';
        console.log(`  → FIX: Use "Dorzolamide-Timolol" (${altCoverage.matches.length} BIN matches)`);
      }
    }

    // 23. Generic fallback: try removing words one at a time
    if (!newRecommendedDrug && f.words.length > 1) {
      console.log(`  → Trying to find working subset of keywords...`);
      // Try each word individually
      for (const w of f.words) {
        const singleCoverage = await testCoverageMatch([w], t.exclude_keywords);
        if (singleCoverage.matches.length > 0) {
          console.log(`    "${w}" alone: ${singleCoverage.matches.length} BIN matches`);
        } else {
          console.log(`    "${w}" alone: 0 matches`);
        }
      }
      // Try combinations of 2
      if (f.words.length >= 2) {
        for (let i = 0; i < f.words.length; i++) {
          for (let j = i + 1; j < f.words.length; j++) {
            const pair = [f.words[i], f.words[j]];
            const pairCoverage = await testCoverageMatch(pair, t.exclude_keywords);
            if (pairCoverage.matches.length > 0) {
              console.log(`    [${pair.join(', ')}]: ${pairCoverage.matches.length} BIN matches`);
              if (!newRecommendedDrug) {
                newRecommendedDrug = pair.map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
                reason = `Best 2-keyword combination: [${pair.join(', ')}]`;
              }
            }
          }
        }
      }
    }

    // 24. Single-word fallback
    if (!newRecommendedDrug && f.words.length === 1) {
      console.log(`  → Single keyword "${f.words[0]}" has no matches`);
      // Check if it's a misspelling or abbreviation
      const basicCheck = await testKeywords(f.words, []);
      if (basicCheck.matches.length > 0) {
        console.log(`  → Has basic matches (but no coverage):`);
        basicCheck.matches.forEach(m => console.log(`    ${m.drug_name} | claims:${m.cnt} | gp_claims:${m.gp_claims} | has_bin:${m.has_bin}`));
        if (basicCheck.matches.every(m => m.gp_claims === '0' || m.gp_claims === 0)) {
          console.log(`  → All matches have GP = 0 — no profitable claims available`);
        } else if (basicCheck.matches.every(m => !m.has_bin)) {
          console.log(`  → All matches missing insurance BIN — cash/unknown claims only`);
        }
      }
    }

    if (!newRecommendedDrug) {
      console.log(`  → NO FIX FOUND — may need manual review`);
      continue;
    }

    fixes.push({ triggerId: t.trigger_id, displayName: t.display_name, oldRec: t.recommended_drug, newRec: newRecommendedDrug, reason });
  }

  // Apply fixes
  console.log('\n\n====== APPLYING FIXES ======\n');
  let applied = 0;
  for (const fix of fixes) {
    if (fix.newRec === fix.oldRec) {
      console.log(`SKIP ${fix.displayName}: recommended_drug unchanged`);
      continue;
    }
    console.log(`${fix.displayName}:`);
    console.log(`  Reason: ${fix.reason}`);
    console.log(`  OLD: "${fix.oldRec}"`);
    console.log(`  NEW: "${fix.newRec}"`);

    const result = await updateTrigger(token, fix.triggerId, { recommendedDrug: fix.newRec });
    if (result.trigger || result.success) {
      console.log(`  ✓ Updated`);
      applied++;
    } else {
      console.log(`  ✗ FAILED: ${result.error || JSON.stringify(result)}`);
    }
  }

  console.log(`\n\nSUMMARY:`);
  console.log(`  Passing: ${passing.length}`);
  console.log(`  Failing: ${failing.length}`);
  console.log(`  Fixes applied: ${applied}`);
  console.log(`  Still unfixed: ${failing.length - applied}`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
