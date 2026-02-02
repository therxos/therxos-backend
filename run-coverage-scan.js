/**
 * Run Coverage Scan for All Triggers
 * Populates trigger_bin_values with verified BIN/Groups
 */

import 'dotenv/config';
import db from './src/database/index.js';

async function runCoverageScan() {
  console.log('=== BULK SCAN ALL TRIGGERS ===\n');

  const minClaims = 1;
  const daysBack = 365;
  const minMargin = 0;

  // Get all enabled triggers with recommended drugs
  const triggersResult = await db.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc
    FROM triggers
    WHERE is_enabled = true
    AND (recommended_drug IS NOT NULL AND recommended_drug != '' OR recommended_ndc IS NOT NULL)
    ORDER BY display_name
  `);

  const triggers = triggersResult.rows;
  console.log(`Found ${triggers.length} triggers to scan\n`);

  const results = [];
  const skipWords = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with'];

  for (const trigger of triggers) {
    const recommendedDrug = trigger.recommended_drug || '';

    // Parse search words
    const words = recommendedDrug
      .split(/[\s,.\-\(\)\[\]]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length >= 2 && !skipWords.includes(w.toLowerCase()) && !/^\d+$/.test(w));

    if (words.length === 0 && !trigger.recommended_ndc) {
      results.push({
        trigger_id: trigger.trigger_id,
        name: trigger.display_name,
        status: 'skipped',
        reason: 'No search terms or NDC'
      });
      continue;
    }

    // Build query
    let matchParams = [];
    let paramIndex = 1;
    const conditions = words.map(word => {
      matchParams.push(word);
      return `UPPER(drug_name) LIKE '%' || $${paramIndex++} || '%'`;
    });

    const keywordCondition = conditions.length > 0 ? `(${conditions.join(' AND ')})` : 'FALSE';

    // Add NDC condition if present
    let ndcCondition = '';
    if (trigger.recommended_ndc) {
      matchParams.push(trigger.recommended_ndc);
      ndcCondition = ` OR ndc = $${paramIndex++}`;
    }

    matchParams.push(parseInt(minClaims));
    const minClaimsIdx = paramIndex++;
    matchParams.push(parseInt(daysBack));
    const daysBackIdx = paramIndex++;
    matchParams.push(parseFloat(minMargin));
    const minMarginIdx = paramIndex++;

    const matchQuery = `
      SELECT
        insurance_bin as bin,
        insurance_group as "group",
        COUNT(*) as claim_count,
        AVG(COALESCE(
            NULLIF((raw_data->>'gross_profit')::numeric, 0),
            NULLIF((raw_data->>'Gross Profit')::numeric, 0),
            NULLIF((raw_data->>'grossprofit')::numeric, 0),
            NULLIF((raw_data->>'GrossProfit')::numeric, 0),
            NULLIF((raw_data->>'net_profit')::numeric, 0),
            NULLIF((raw_data->>'Net Profit')::numeric, 0),
            NULLIF((raw_data->>'netprofit')::numeric, 0),
            NULLIF((raw_data->>'NetProfit')::numeric, 0),
            NULLIF((raw_data->>'adj_profit')::numeric, 0),
            NULLIF((raw_data->>'Adj Profit')::numeric, 0),
            NULLIF((raw_data->>'adjprofit')::numeric, 0),
            NULLIF((raw_data->>'AdjProfit')::numeric, 0),
            NULLIF((raw_data->>'Adjusted Profit')::numeric, 0),
            NULLIF((raw_data->>'adjusted_profit')::numeric, 0),
            NULLIF(
              REPLACE(COALESCE(raw_data->>'Price','0'), '$', '')::numeric
              - REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', '')::numeric,
            0),
            COALESCE(insurance_pay,0) + COALESCE(patient_pay,0) - COALESCE(acquisition_cost,0)
          )) as avg_reimbursement,
        AVG(COALESCE(quantity_dispensed, 1)) as avg_qty,
        MAX(COALESCE(dispensed_date, created_at)) as most_recent_claim
      FROM prescriptions
      WHERE (${keywordCondition}${ndcCondition})
      AND insurance_bin IS NOT NULL AND insurance_bin != ''
      AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackIdx}
      GROUP BY insurance_bin, insurance_group
      HAVING COUNT(*) >= $${minClaimsIdx}
        AND AVG(COALESCE(
            NULLIF((raw_data->>'gross_profit')::numeric, 0),
            NULLIF((raw_data->>'Gross Profit')::numeric, 0),
            NULLIF((raw_data->>'grossprofit')::numeric, 0),
            NULLIF((raw_data->>'GrossProfit')::numeric, 0),
            NULLIF((raw_data->>'net_profit')::numeric, 0),
            NULLIF((raw_data->>'Net Profit')::numeric, 0),
            NULLIF((raw_data->>'netprofit')::numeric, 0),
            NULLIF((raw_data->>'NetProfit')::numeric, 0),
            NULLIF((raw_data->>'adj_profit')::numeric, 0),
            NULLIF((raw_data->>'Adj Profit')::numeric, 0),
            NULLIF((raw_data->>'adjprofit')::numeric, 0),
            NULLIF((raw_data->>'AdjProfit')::numeric, 0),
            NULLIF((raw_data->>'Adjusted Profit')::numeric, 0),
            NULLIF((raw_data->>'adjusted_profit')::numeric, 0),
            NULLIF(
              REPLACE(COALESCE(raw_data->>'Price','0'), '$', '')::numeric
              - REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', '')::numeric,
            0),
            COALESCE(insurance_pay,0) + COALESCE(patient_pay,0) - COALESCE(acquisition_cost,0)
          )) >= $${minMarginIdx}
      ORDER BY avg_reimbursement DESC, claim_count DESC
    `;

    try {
      const matches = await db.query(matchQuery, matchParams);

      // Upsert matches
      let verified = 0;
      for (const match of matches.rows) {
        await db.query(`
          INSERT INTO trigger_bin_values (
            trigger_id, insurance_bin, insurance_group, coverage_status,
            verified_at, verified_claim_count, avg_reimbursement, avg_qty, gp_value
          )
          VALUES ($1, $2, $3, 'verified', NOW(), $4, $5, $6, $5)
          ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
          DO UPDATE SET
            coverage_status = 'verified',
            verified_at = NOW(),
            verified_claim_count = $4,
            avg_reimbursement = $5,
            avg_qty = $6,
            gp_value = GREATEST(trigger_bin_values.gp_value, $5)
        `, [
          trigger.trigger_id,
          match.bin,
          match.group || null,
          parseInt(match.claim_count),
          parseFloat(match.avg_reimbursement) || 0,
          parseFloat(match.avg_qty) || 1
        ]);
        verified++;
      }

      results.push({
        trigger_id: trigger.trigger_id,
        name: trigger.display_name,
        status: 'success',
        matches_found: matches.rows.length,
        verified: verified
      });

      if (verified > 0) {
        console.log(`✓ ${trigger.display_name}: ${verified} BIN/Groups verified`);
      }
    } catch (queryError) {
      results.push({
        trigger_id: trigger.trigger_id,
        name: trigger.display_name,
        status: 'error',
        error: queryError.message
      });
      console.error(`✗ ${trigger.display_name}: ${queryError.message}`);
    }
  }

  const summary = {
    total_triggers: triggers.length,
    successful: results.filter(r => r.status === 'success').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    errors: results.filter(r => r.status === 'error').length,
    total_verified: results.reduce((sum, r) => sum + (r.verified || 0), 0)
  };

  console.log(`\n=== SCAN COMPLETE ===`);
  console.log(`Total Triggers: ${summary.total_triggers}`);
  console.log(`Successful: ${summary.successful}`);
  console.log(`Skipped: ${summary.skipped}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Total BIN/Groups Verified: ${summary.total_verified}`);

  process.exit(0);
}

runCoverageScan().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
