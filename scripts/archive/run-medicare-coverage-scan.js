/**
 * Scan Medicare Coverage for All Triggers
 * Checks if recommended drugs are covered under Medicare Part D formularies
 * Uses the local CMS formulary database (1.3M+ drug records)
 *
 * Since triggers have drug names (not NDCs), we:
 * 1. Find actual dispensed NDCs that match the recommended drug name
 * 2. Check those NDCs against the CMS formulary for each Medicare contract
 */

import 'dotenv/config';
import db from './src/database/index.js';
import { checkMedicareCoverage } from './src/services/medicare.js';

const skipWords = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with', 'to'];

function parseSearchWords(drugName) {
  return drugName
    .split(/[\s,.\-\(\)\[\]]+/)
    .map(w => w.trim().toUpperCase())
    .filter(w => w.length >= 3 && !skipWords.includes(w.toLowerCase()) && !/^\d+$/.test(w));
}

async function runMedicareCoverageScan() {
  console.log('=== MEDICARE FORMULARY COVERAGE SCAN ===\n');

  // Get all enabled triggers with recommended drugs
  const triggersResult = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc
    FROM triggers
    WHERE is_enabled = true
    AND (recommended_drug IS NOT NULL AND recommended_drug != '')
    ORDER BY display_name
  `);

  const triggers = triggersResult.rows;
  console.log(`Found ${triggers.length} triggers to scan\n`);

  // Get unique Medicare contracts from prescriptions
  const contractsResult = await db.query(`
    SELECT DISTINCT contract_id, COUNT(*) as claim_count
    FROM prescriptions
    WHERE contract_id IS NOT NULL
    AND contract_id ~ '^[HSR][0-9]{4}$'
    GROUP BY contract_id
    ORDER BY claim_count DESC
    LIMIT 25
  `);

  const contracts = contractsResult.rows;
  console.log(`Found ${contracts.length} Medicare contracts to check against\n`);

  let totalCovered = 0;
  let totalNotCovered = 0;
  let totalNotFound = 0;
  let totalNoNdc = 0;

  for (const trigger of triggers) {
    const recommendedDrug = trigger.recommended_drug || '';
    const words = parseSearchWords(recommendedDrug);

    if (words.length === 0) {
      console.log(`SKIP: ${trigger.display_name} - no searchable words`);
      totalNoNdc++;
      continue;
    }

    // Find actual dispensed NDCs matching the drug name
    const conditions = words.map((_, i) => `UPPER(drug_name) LIKE '%' || $${i + 1} || '%'`);
    const ndcResult = await db.query(`
      SELECT DISTINCT ndc, drug_name, COUNT(*) as claim_count
      FROM prescriptions
      WHERE ${conditions.join(' AND ')}
      AND ndc IS NOT NULL AND ndc != ''
      GROUP BY ndc, drug_name
      ORDER BY claim_count DESC
      LIMIT 3
    `, words);

    if (ndcResult.rows.length === 0) {
      console.log(`SKIP: ${trigger.display_name} - no matching NDCs found in claims`);
      totalNoNdc++;
      continue;
    }

    console.log(`\n--- ${trigger.display_name} ---`);
    console.log(`  Searching: ${words.join(', ')}`);
    console.log(`  Found NDCs: ${ndcResult.rows.map(r => `${r.ndc} (${r.drug_name.substring(0, 30)})`).join(', ')}`);

    let covered = 0;
    let notCovered = 0;
    let notFound = 0;

    // Check each NDC against each Medicare contract
    for (const ndcRow of ndcResult.rows) {
      for (const contract of contracts) {
        const coverage = await checkMedicareCoverage(contract.contract_id, null, ndcRow.ndc);

        if (coverage.covered) {
          covered++;

          // Store in trigger_bin_values
          await db.query(`
            INSERT INTO trigger_bin_values (
              trigger_id, insurance_bin, insurance_group, coverage_status,
              verified_at, verified_claim_count, avg_reimbursement, gp_value,
              medicare_tier, medicare_prior_auth, medicare_step_therapy,
              best_ndc, best_drug_name
            )
            VALUES ($1, $2, $3, 'verified', NOW(), $4, $5, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
            DO UPDATE SET
              coverage_status = 'verified',
              verified_at = NOW(),
              medicare_tier = COALESCE($6, trigger_bin_values.medicare_tier),
              medicare_prior_auth = COALESCE($7, trigger_bin_values.medicare_prior_auth),
              medicare_step_therapy = COALESCE($8, trigger_bin_values.medicare_step_therapy),
              best_ndc = COALESCE($9, trigger_bin_values.best_ndc),
              best_drug_name = COALESCE($10, trigger_bin_values.best_drug_name)
          `, [
            trigger.trigger_id,
            `MEDICARE:${contract.contract_id}`,
            (coverage.planName || '').substring(0, 50) || null,
            parseInt(contract.claim_count),
            coverage.estimatedCopay || 0,
            coverage.tier,
            coverage.priorAuth,
            coverage.stepTherapy,
            ndcRow.ndc,
            ndcRow.drug_name
          ]);
        } else if (coverage.reason === 'Not on formulary') {
          notCovered++;
        } else {
          notFound++;
        }
      }
    }

    console.log(`  Medicare Coverage: ${covered} covered, ${notCovered} not covered, ${notFound} contract not found`);

    totalCovered += covered;
    totalNotCovered += notCovered;
    totalNotFound += notFound;
  }

  console.log('\n=== SCAN COMPLETE ===');
  console.log(`Triggers processed: ${triggers.length - totalNoNdc}`);
  console.log(`Triggers skipped (no NDC): ${totalNoNdc}`);
  console.log(`Coverage entries added: ${totalCovered}`);
  console.log(`Not on formulary: ${totalNotCovered}`);
  console.log(`Contract not found: ${totalNotFound}`);

  process.exit(0);
}

runMedicareCoverageScan().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
