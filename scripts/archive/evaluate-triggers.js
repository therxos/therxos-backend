import 'dotenv/config';
import db from './src/database/index.js';

// Evaluate each trigger's keyword matching against actual prescription data
async function main() {
  const triggers = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc,
           detection_keywords, exclude_keywords, trigger_type, is_enabled,
           expected_qty, expected_days_supply
    FROM triggers WHERE is_enabled = true ORDER BY display_name
  `);

  console.log(`Evaluating ${triggers.rows.length} enabled triggers against prescription data...\n`);

  const issues = [];

  for (const t of triggers.rows) {
    const searchTerm = t.recommended_drug || '';
    if (!searchTerm) {
      issues.push({ trigger: t.display_name, issue: 'NO recommended_drug set' });
      continue;
    }

    // What keywords does the scanner extract?
    const SKIP_WORDS = ['mg', 'mcg', 'ml', 'tab', 'cap', 'sol', 'cream', 'gel', 'oint', 'susp', 'inj', 'er', 'hcl', 'dr', 'sr', 'xr'];
    const words = searchTerm
      .split(/[\s,.\-\(\)\[\]]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length >= 2 && !SKIP_WORDS.includes(w.toLowerCase()) && !/^\d+$/.test(w));

    if (words.length === 0) {
      issues.push({ trigger: t.display_name, issue: `recommended_drug "${searchTerm}" produces no search words after filtering` });
      continue;
    }

    // Build the same POSITION query the scanner uses
    const conditions = words.map((w, i) => {
      return `POSITION($${i + 1} IN UPPER(drug_name)) > 0`;
    });
    const whereClause = conditions.join(' AND ');

    // Build exclude conditions
    const excludeKeywords = t.exclude_keywords || [];
    let excludeClause = '';
    const excludeParams = [];
    if (excludeKeywords.length > 0) {
      const excludeParts = excludeKeywords.map(kw => {
        const excludeWords = kw.split(/[\s,.\-\(\)\[\]]+/)
          .map(w => w.trim().toUpperCase())
          .filter(w => w.length >= 2);
        if (excludeWords.length === 0) return null;
        return '(' + excludeWords.map(word => {
          excludeParams.push(word);
          return `POSITION($${words.length + excludeParams.length} IN UPPER(drug_name)) > 0`;
        }).join(' AND ') + ')';
      }).filter(Boolean);
      if (excludeParts.length > 0) {
        excludeClause = `AND NOT (${excludeParts.join(' OR ')})`;
      }
    }

    // Count matching prescriptions
    const allParams = [...words, ...excludeParams];
    const countQuery = `
      SELECT COUNT(DISTINCT drug_name) as drug_count,
             COUNT(*) as claim_count
      FROM prescriptions
      WHERE ${whereClause} ${excludeClause}
        AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
    `;

    const countResult = await db.query(countQuery, allParams);
    const drugCount = parseInt(countResult.rows[0].drug_count);
    const claimCount = parseInt(countResult.rows[0].claim_count);

    // Get sample drug names that match
    const sampleQuery = `
      SELECT DISTINCT UPPER(drug_name) as drug_name, COUNT(*) as cnt
      FROM prescriptions
      WHERE ${whereClause} ${excludeClause}
        AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
      GROUP BY UPPER(drug_name)
      ORDER BY cnt DESC
      LIMIT 10
    `;
    const sampleResult = await db.query(sampleQuery, allParams);

    // Also check: what would match WITHOUT excludes?
    let withoutExcludeCount = drugCount;
    let excludedDrugs = [];
    if (excludeClause) {
      const noExcludeQuery = `
        SELECT DISTINCT UPPER(drug_name) as drug_name, COUNT(*) as cnt
        FROM prescriptions
        WHERE ${whereClause}
          AND drug_name IS NOT NULL AND TRIM(drug_name) != ''
        GROUP BY UPPER(drug_name)
        ORDER BY cnt DESC
        LIMIT 20
      `;
      const noExcludeResult = await db.query(noExcludeQuery, words);
      withoutExcludeCount = noExcludeResult.rows.length;
      // Find what's excluded
      const matchedNames = new Set(sampleResult.rows.map(r => r.drug_name));
      excludedDrugs = noExcludeResult.rows.filter(r => !matchedNames.has(r.drug_name));
    }

    // Check for false positives (drugs that don't seem related)
    const matchingDrugs = sampleResult.rows.map(r => r.drug_name);

    console.log(`--- ${t.display_name} ---`);
    console.log(`  Search: "${searchTerm}" → keywords: [${words.join(', ')}]`);
    console.log(`  Exclude keywords: ${JSON.stringify(excludeKeywords)}`);
    console.log(`  Matched: ${drugCount} unique drugs, ${claimCount} claims`);
    if (matchingDrugs.length > 0) {
      matchingDrugs.forEach(d => console.log(`    ✓ ${d}`));
    } else {
      console.log(`    (no matches)`);
    }
    if (excludedDrugs.length > 0) {
      console.log(`  Excluded by keywords:`);
      excludedDrugs.forEach(d => console.log(`    ✗ ${d.drug_name} (${d.cnt} claims)`));
    }

    // Flag potential issues
    if (drugCount === 0 && claimCount === 0) {
      issues.push({ trigger: t.display_name, issue: `0 matches - keywords [${words.join(', ')}] find nothing in prescriptions` });
    }

    // Check if exclude_keywords accidentally exclude the recommended drug
    if (excludeKeywords.length > 0) {
      for (const ekw of excludeKeywords) {
        const eWords = ekw.split(/[\s,.\-\(\)\[\]]+/).map(w => w.trim().toUpperCase()).filter(w => w.length >= 2);
        // Check if ALL exclude words are present in ALL search words
        const searchSet = new Set(words);
        if (eWords.every(ew => searchSet.has(ew)) || eWords.every(ew => words.some(sw => sw.includes(ew)))) {
          issues.push({ trigger: t.display_name, issue: `exclude_keywords "${ekw}" may exclude the recommended drug itself` });
        }
      }
    }

    console.log('');
  }

  console.log('\n====== ISSUES FOUND ======');
  if (issues.length === 0) {
    console.log('No issues found!');
  } else {
    issues.forEach(i => console.log(`  ⚠ ${i.trigger}: ${i.issue}`));
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
