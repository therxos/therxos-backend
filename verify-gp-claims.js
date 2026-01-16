import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function verify() {
  console.log('='.repeat(90));
  console.log('VERIFYING GP VALUES AGAINST ACTUAL PAID CLAIMS AT HEIGHTS CHEMIST');
  console.log('='.repeat(90));

  // Get all triggers with their recommended drugs
  const triggers = await pool.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc, default_gp_value
    FROM triggers
    WHERE is_enabled = true AND recommended_drug IS NOT NULL
    ORDER BY default_gp_value DESC
  `);

  console.log(`\nChecking ${triggers.rows.length} triggers against actual prescription data...\n`);

  const verified = [];
  const notFound = [];
  const partialMatch = [];

  for (const trigger of triggers.rows) {
    const recDrug = (trigger.recommended_drug || '').toUpperCase();
    const recNdc = (trigger.recommended_ndc || '').replace(/-/g, '');

    // Extract keywords from recommended drug name
    const keywords = recDrug.split(/[\s,()-]+/).filter(w => w.length > 3);

    // Search for matching prescriptions at Heights Chemist
    let claims = [];

    // Try NDC match first
    if (recNdc && recNdc.length >= 10) {
      const ndcResult = await pool.query(`
        SELECT drug_name, ndc, insurance_bin, insurance_group,
               COUNT(*) as rx_count,
               AVG(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as avg_gp,
               SUM(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as total_gp,
               AVG(COALESCE(insurance_pay, 0)) as avg_ins_pay,
               AVG(COALESCE(acquisition_cost, 0)) as avg_acq_cost
        FROM prescriptions
        WHERE pharmacy_id = $1
          AND REPLACE(ndc, '-', '') = $2
        GROUP BY drug_name, ndc, insurance_bin, insurance_group
        ORDER BY rx_count DESC
      `, [pharmacyId, recNdc]);
      claims = ndcResult.rows;
    }

    // If no NDC match, try keyword match
    if (claims.length === 0 && keywords.length > 0) {
      // Build a query that matches any keyword
      const keywordConditions = keywords.map((_, i) => `UPPER(drug_name) LIKE '%' || $${i + 2} || '%'`).join(' OR ');
      const keywordResult = await pool.query(`
        SELECT drug_name, ndc, insurance_bin, insurance_group,
               COUNT(*) as rx_count,
               AVG(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as avg_gp,
               SUM(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as total_gp,
               AVG(COALESCE(insurance_pay, 0)) as avg_ins_pay,
               AVG(COALESCE(acquisition_cost, 0)) as avg_acq_cost
        FROM prescriptions
        WHERE pharmacy_id = $1
          AND (${keywordConditions})
        GROUP BY drug_name, ndc, insurance_bin, insurance_group
        ORDER BY rx_count DESC
        LIMIT 10
      `, [pharmacyId, ...keywords]);
      claims = keywordResult.rows;
    }

    if (claims.length > 0) {
      const totalRx = claims.reduce((sum, c) => sum + parseInt(c.rx_count), 0);
      const avgGp = claims.reduce((sum, c) => sum + parseFloat(c.avg_gp || 0), 0) / claims.length;

      verified.push({
        trigger: trigger.display_name,
        recommendedDrug: trigger.recommended_drug,
        assumedGp: trigger.default_gp_value,
        actualAvgGp: avgGp,
        difference: avgGp - (trigger.default_gp_value || 50),
        differencePercent: ((avgGp - (trigger.default_gp_value || 50)) / (trigger.default_gp_value || 50) * 100),
        totalRx: totalRx,
        claims: claims.slice(0, 3) // Top 3 matches
      });
    } else {
      notFound.push({
        trigger: trigger.display_name,
        recommendedDrug: trigger.recommended_drug,
        assumedGp: trigger.default_gp_value
      });
    }
  }

  // Display verified triggers
  console.log('='.repeat(90));
  console.log(`VERIFIED TRIGGERS (Found ${verified.length} with actual paid claims)`);
  console.log('='.repeat(90));
  console.log('Trigger'.padEnd(40) + ' | Assumed GP | Actual GP | Diff    | Rx Count');
  console.log('-'.repeat(90));

  // Sort by difference (biggest discrepancies first)
  verified.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));

  for (const v of verified) {
    const diffStr = v.difference >= 0 ? `+$${v.difference.toFixed(0)}` : `-$${Math.abs(v.difference).toFixed(0)}`;
    console.log(
      v.trigger.substring(0, 38).padEnd(40),
      '|', ('$' + (v.assumedGp || 50)).padStart(10),
      '|', ('$' + v.actualAvgGp.toFixed(2)).padStart(9),
      '|', diffStr.padStart(7),
      '|', String(v.totalRx).padStart(6)
    );
  }

  // Show detailed breakdown for top verified
  console.log('\n' + '='.repeat(90));
  console.log('DETAILED BREAKDOWN - TOP VERIFIED TRIGGERS BY RX COUNT');
  console.log('='.repeat(90));

  const topVerified = [...verified].sort((a, b) => b.totalRx - a.totalRx).slice(0, 10);

  for (const v of topVerified) {
    console.log(`\n${v.trigger}`);
    console.log(`  Recommended: ${v.recommendedDrug}`);
    console.log(`  Assumed GP: $${v.assumedGp} | Actual Avg GP: $${v.actualAvgGp.toFixed(2)} | Total Rx: ${v.totalRx}`);
    console.log('  Actual claims by BIN/Group:');
    for (const c of v.claims) {
      console.log(`    - ${c.drug_name?.substring(0, 30) || 'N/A'} | BIN: ${c.insurance_bin || 'N/A'} | ${c.rx_count} rx | Avg GP: $${parseFloat(c.avg_gp || 0).toFixed(2)} | Avg Ins Pay: $${parseFloat(c.avg_ins_pay || 0).toFixed(2)}`);
    }
  }

  // Display not found
  console.log('\n' + '='.repeat(90));
  console.log(`NOT FOUND - No matching claims (${notFound.length} triggers)`);
  console.log('='.repeat(90));
  for (const nf of notFound) {
    console.log(`  ${nf.trigger.substring(0, 50).padEnd(52)} | Rec: ${nf.recommendedDrug?.substring(0, 25) || 'N/A'} | GP: $${nf.assumedGp}`);
  }

  // Summary
  console.log('\n' + '='.repeat(90));
  console.log('SUMMARY');
  console.log('='.repeat(90));
  console.log(`Triggers with verified claims: ${verified.length}`);
  console.log(`Triggers without matching claims: ${notFound.length}`);

  const avgDiff = verified.reduce((sum, v) => sum + v.difference, 0) / verified.length;
  console.log(`Average GP difference: ${avgDiff >= 0 ? '+' : ''}$${avgDiff.toFixed(2)}`);

  const underEstimated = verified.filter(v => v.difference > 10).length;
  const overEstimated = verified.filter(v => v.difference < -10).length;
  const accurate = verified.filter(v => Math.abs(v.difference) <= 10).length;

  console.log(`\nGP Accuracy (within $10):`);
  console.log(`  Accurate: ${accurate} (${(accurate/verified.length*100).toFixed(0)}%)`);
  console.log(`  Under-estimated: ${underEstimated} (actual GP higher than assumed)`);
  console.log(`  Over-estimated: ${overEstimated} (actual GP lower than assumed)`);

  await pool.end();
}

verify().catch(console.error);
