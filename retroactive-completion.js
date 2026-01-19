/**
 * Retroactive Auto-Completion
 * Matches Approved opportunities against recently dispensed prescriptions
 */

import 'dotenv/config';
import db from './src/database/index.js';

async function runRetroactive() {
  console.log('=== Retroactive Auto-Completion ===\n');

  // Get Bravo pharmacy ID
  const pharmacyResult = await db.query(`
    SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%' LIMIT 1
  `);
  const pharmacyId = pharmacyResult.rows[0].pharmacy_id;

  // Get all Approved opportunities
  const opportunities = await db.query(`
    SELECT o.*, p.first_name as pat_first, p.last_name as pat_last
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.pharmacy_id = $1
    AND o.status = 'Approved'
    AND (o.recommended_drug IS NOT NULL OR o.recommended_drug_name IS NOT NULL)
  `, [pharmacyId]);

  console.log(`Found ${opportunities.rows.length} Approved opportunities to check\n`);

  // Get recent prescriptions (last 30 days)
  const prescriptions = await db.query(`
    SELECT pr.*, pat.first_name as patient_first, pat.last_name as patient_last
    FROM prescriptions pr
    LEFT JOIN patients pat ON pat.patient_id = pr.patient_id
    WHERE pr.pharmacy_id = $1
    AND pr.dispensed_date > NOW() - INTERVAL '30 days'
  `, [pharmacyId]);

  console.log(`Checking against ${prescriptions.rows.length} recent prescriptions\n`);

  // Helper functions (same as gmailPoller)
  const cleanName = (name) => (name || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z]/g, '').trim();
  const cleanDrug = (drug) => (drug || '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^a-z0-9\s]/g, '').trim();

  let matched = 0;
  let updated = 0;

  for (const opp of opportunities.rows) {
    const recommendedDrugRaw = opp.recommended_drug || opp.recommended_drug_name || '';
    const recommendedDrug = cleanDrug(recommendedDrugRaw);
    if (!recommendedDrug) continue;

    const recommendedWords = recommendedDrug.split(/\s+/).filter(w => w.length > 2);
    const recommendedFirstWord = recommendedWords[0] || '';

    const oppPatFirst = cleanName(opp.pat_first);
    const oppPatLast = cleanName(opp.pat_last);

    // Find matching prescription
    const matchingRx = prescriptions.rows.find(rx => {
      const rxPatFirst = cleanName(rx.patient_first);
      const rxPatLast = cleanName(rx.patient_last);

      // Patient name must match
      const patientMatches = (
        (rxPatFirst && oppPatFirst && (rxPatFirst.includes(oppPatFirst) || oppPatFirst.includes(rxPatFirst))) &&
        (rxPatLast && oppPatLast && (rxPatLast.includes(oppPatLast) || oppPatLast.includes(rxPatLast)))
      );

      if (!patientMatches) return false;

      // Drug must match
      const dispensedDrug = cleanDrug(rx.drug_name);
      const dispensedWords = dispensedDrug.split(/\s+/).filter(w => w.length > 2);
      const dispensedFirstWord = dispensedWords[0] || '';

      const drugMatches = (
        (recommendedFirstWord && dispensedFirstWord &&
         (dispensedFirstWord.includes(recommendedFirstWord) || recommendedFirstWord.includes(dispensedFirstWord))) ||
        dispensedDrug.includes(recommendedFirstWord) ||
        recommendedDrug.includes(dispensedFirstWord)
      );

      return drugMatches;
    });

    if (matchingRx) {
      matched++;
      console.log(`✓ MATCH: ${opp.pat_first} ${opp.pat_last}`);
      console.log(`  Recommended: ${recommendedDrugRaw}`);
      console.log(`  Dispensed: ${matchingRx.drug_name} on ${matchingRx.dispensed_date?.toISOString().split('T')[0]}`);

      // Update to Completed
      await db.query(`
        UPDATE opportunities
        SET status = 'Completed',
            actioned_at = NOW(),
            updated_at = NOW(),
            staff_notes = COALESCE(staff_notes, '') || E'\n[Retroactive auto-complete] Patient filled ' || $1 || ' on ' || $2
        WHERE opportunity_id = $3
      `, [matchingRx.drug_name, matchingRx.dispensed_date?.toISOString().split('T')[0], opp.opportunity_id]);

      updated++;
      console.log('  → Updated to Completed\n');
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Opportunities checked: ${opportunities.rows.length}`);
  console.log(`Matches found: ${matched}`);
  console.log(`Updated to Completed: ${updated}`);

  process.exit(0);
}

runRetroactive().catch(e => { console.error(e); process.exit(1); });
