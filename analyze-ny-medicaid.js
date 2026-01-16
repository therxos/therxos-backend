import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function analyze() {
  // Load the NY Medicaid formulary
  const formularyData = fs.readFileSync('MedReimbDrugsFormulary.csv', 'utf-8');
  const lines = formularyData.split('\n');
  const headers = lines[0].split(',').map(h => h.trim());

  // Parse formulary into a searchable structure
  const formulary = [];
  const formularyByGenericName = {};
  const formularyByDescription = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Parse CSV (handle commas in descriptions)
    const values = line.match(/(?:^|,)("(?:[^"]*(?:""[^"]*)*)"|[^,]*)/g);
    if (!values || values.length < 10) continue;

    const cleanValues = values.map(v => v.replace(/^,/, '').replace(/^"|"$/g, '').trim());

    const entry = {
      type: cleanValues[0],
      ndc: cleanValues[1],
      mraCost: parseFloat(cleanValues[2]) || 0,
      description: cleanValues[4],
      pa: cleanValues[5],
      genericName: cleanValues[9],
      preferredCode: cleanValues[13], // X=preferred, Y/N=not preferred
    };

    formulary.push(entry);

    // Index by generic name (uppercase for matching)
    const genKey = (entry.genericName || '').toUpperCase();
    if (genKey) {
      if (!formularyByGenericName[genKey]) formularyByGenericName[genKey] = [];
      formularyByGenericName[genKey].push(entry);
    }

    // Index by description (uppercase for matching)
    const descKey = (entry.description || '').toUpperCase();
    if (descKey) {
      if (!formularyByDescription[descKey]) formularyByDescription[descKey] = [];
      formularyByDescription[descKey].push(entry);
    }
  }

  console.log(`Loaded ${formulary.length} formulary entries`);
  console.log(`Unique generic names: ${Object.keys(formularyByGenericName).length}`);

  // Get all triggers with recommended drugs
  const triggers = await pool.query(`
    SELECT trigger_id, trigger_type, display_name, recommended_drug, recommended_ndc,
           default_gp_value, detection_keywords,
           (SELECT COUNT(*) FROM trigger_bin_values WHERE trigger_id = t.trigger_id) as bin_count,
           (SELECT COUNT(*) FROM trigger_bin_values WHERE trigger_id = t.trigger_id AND insurance_bin = '004740') as has_004740
    FROM triggers t
    WHERE is_enabled = true AND recommended_drug IS NOT NULL
    ORDER BY trigger_type, display_name
  `);

  console.log(`\n${'='.repeat(100)}`);
  console.log('TRIGGER ANALYSIS - NY MEDICAID (BIN 004740) COVERAGE');
  console.log('='.repeat(100));

  const matchedTriggers = [];
  const notFoundTriggers = [];
  const alreadyHas004740 = [];

  for (const trigger of triggers.rows) {
    const recDrug = (trigger.recommended_drug || '').toUpperCase();
    const recNdc = (trigger.recommended_ndc || '').replace(/-/g, '');

    // Search in formulary
    let matches = [];

    // Try exact NDC match first
    if (recNdc) {
      matches = formulary.filter(f => f.ndc.replace(/-/g, '') === recNdc);
    }

    // Try generic name match
    if (matches.length === 0) {
      // Extract key words from recommended drug
      const keywords = recDrug.split(/[\s,]+/).filter(w => w.length > 3);

      for (const [genName, entries] of Object.entries(formularyByGenericName)) {
        const genUpper = genName.toUpperCase();
        // Check if any keyword matches
        if (keywords.some(kw => genUpper.includes(kw))) {
          matches.push(...entries);
        }
      }

      // Also search descriptions
      for (const [desc, entries] of Object.entries(formularyByDescription)) {
        if (keywords.some(kw => desc.includes(kw))) {
          // Avoid duplicates
          for (const e of entries) {
            if (!matches.find(m => m.ndc === e.ndc)) {
              matches.push(e);
            }
          }
        }
      }
    }

    // Check if preferred
    const preferredMatches = matches.filter(m => m.preferredCode === 'X');
    const hasPreferred = preferredMatches.length > 0;

    if (trigger.has_004740 > 0) {
      alreadyHas004740.push({
        trigger,
        matches,
        hasPreferred
      });
    } else if (matches.length > 0) {
      matchedTriggers.push({
        trigger,
        matches,
        hasPreferred
      });
    } else {
      notFoundTriggers.push(trigger);
    }
  }

  // Display results
  console.log(`\n✅ TRIGGERS ALREADY CONFIGURED FOR BIN 004740: ${alreadyHas004740.length}`);
  console.log('-'.repeat(100));
  for (const { trigger, matches, hasPreferred } of alreadyHas004740) {
    const status = hasPreferred ? '✓ PREFERRED' : matches.length > 0 ? '⚠ Non-preferred' : '?';
    console.log(`  ${trigger.display_name.substring(0, 50).padEnd(50)} | GP: $${trigger.default_gp_value || 50} | ${status}`);
  }

  console.log(`\n🎯 TRIGGERS TO ADD BIN 004740 (Found in Formulary): ${matchedTriggers.length}`);
  console.log('-'.repeat(100));
  for (const { trigger, matches, hasPreferred } of matchedTriggers) {
    const status = hasPreferred ? '✓ PREFERRED' : '⚠ NON-PREFERRED';
    const sampleMatch = matches[0];
    console.log(`  ${trigger.display_name.substring(0, 45).padEnd(45)} | GP: $${(trigger.default_gp_value || 50).toString().padStart(3)} | ${status}`);
    console.log(`     Rec: ${trigger.recommended_drug?.substring(0, 40) || 'N/A'}`);
    console.log(`     Match: ${sampleMatch?.description?.substring(0, 40) || 'N/A'} (MRA: $${sampleMatch?.mraCost?.toFixed(2) || '?'})`);
    console.log('');
  }

  console.log(`\n❌ TRIGGERS NOT FOUND IN FORMULARY: ${notFoundTriggers.length}`);
  console.log('-'.repeat(100));
  for (const trigger of notFoundTriggers) {
    console.log(`  ${trigger.display_name.substring(0, 50).padEnd(50)} | Rec: ${trigger.recommended_drug?.substring(0, 30) || 'N/A'}`);
  }

  // Summary
  console.log(`\n${'='.repeat(100)}`);
  console.log('SUMMARY');
  console.log('='.repeat(100));
  console.log(`Total enabled triggers with recommended drugs: ${triggers.rows.length}`);
  console.log(`Already have BIN 004740 configured: ${alreadyHas004740.length}`);
  console.log(`Can add BIN 004740 (found in formulary): ${matchedTriggers.length}`);
  console.log(`Not on NY Medicaid formulary: ${notFoundTriggers.length}`);

  // Calculate potential GP if we add 004740 to matched triggers
  const potentialGP = matchedTriggers.reduce((sum, t) => sum + (t.trigger.default_gp_value || 50), 0);
  console.log(`\nPotential additional GP per match if 004740 added: $${potentialGP}`);

  // Return the triggers to add
  return matchedTriggers.map(t => ({
    trigger_id: t.trigger.trigger_id,
    display_name: t.trigger.display_name,
    recommended_drug: t.trigger.recommended_drug,
    default_gp_value: t.trigger.default_gp_value,
    hasPreferred: t.hasPreferred
  }));
}

// Additional analysis: Check Heights Chemist's 004740 prescriptions for opportunities
async function analyzeHeightsOpportunities() {
  const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

  console.log(`\n${'='.repeat(100)}`);
  console.log('HEIGHTS CHEMIST BIN 004740 DRUG DISTRIBUTION');
  console.log('='.repeat(100));

  // Get top drugs on BIN 004740
  const topDrugs = await pool.query(`
    SELECT drug_name, COUNT(*) as rx_count,
           SUM(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as total_gp,
           AVG(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as avg_gp
    FROM prescriptions
    WHERE pharmacy_id = $1 AND insurance_bin = '004740'
    GROUP BY drug_name
    ORDER BY rx_count DESC
    LIMIT 50
  `, [pharmacyId]);

  console.log('\nTop 50 drugs on BIN 004740 at Heights Chemist:');
  console.log('Drug Name'.padEnd(50) + ' | Rx Count | Total GP     | Avg GP');
  console.log('-'.repeat(90));

  for (const drug of topDrugs.rows) {
    console.log(
      (drug.drug_name || '').substring(0, 48).padEnd(50),
      '|', String(drug.rx_count).padStart(8),
      '|', ('$' + Number(drug.total_gp || 0).toFixed(0)).padStart(12),
      '|', '$' + Number(drug.avg_gp || 0).toFixed(2)
    );
  }

  // Check what trigger keywords might match these drugs
  console.log(`\n${'='.repeat(100)}`);
  console.log('POTENTIAL TRIGGER MATCHES FOR HEIGHTS 004740 DRUGS');
  console.log('='.repeat(100));

  const triggers = await pool.query(`
    SELECT trigger_id, display_name, detection_keywords, recommended_drug, default_gp_value
    FROM triggers WHERE is_enabled = true
  `);

  const potentialMatches = [];

  for (const drug of topDrugs.rows) {
    const drugUpper = (drug.drug_name || '').toUpperCase();

    for (const trigger of triggers.rows) {
      const keywords = trigger.detection_keywords || [];
      const matchesKeyword = keywords.some(kw => drugUpper.includes(kw.toUpperCase()));

      if (matchesKeyword) {
        potentialMatches.push({
          drug: drug.drug_name,
          rxCount: drug.rx_count,
          avgGp: drug.avg_gp,
          trigger: trigger.display_name,
          gpValue: trigger.default_gp_value
        });
      }
    }
  }

  if (potentialMatches.length > 0) {
    console.log('\nDrugs that match trigger detection keywords:');
    console.log('Drug'.padEnd(35) + ' | RxCnt | Trigger'.padEnd(40) + ' | Potential GP');
    console.log('-'.repeat(100));

    for (const match of potentialMatches.slice(0, 30)) {
      console.log(
        (match.drug || '').substring(0, 33).padEnd(35),
        '|', String(match.rxCount).padStart(5),
        '|', (match.trigger || '').substring(0, 38).padEnd(40),
        '|', '$' + (match.gpValue || 50)
      );
    }
  }
}

async function main() {
  const triggersToAdd = await analyze();
  await analyzeHeightsOpportunities();
  await pool.end();
}

main().catch(console.error);
