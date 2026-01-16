import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';
const MEDICAID_BIN = '004740';

async function verify() {
  console.log('='.repeat(90));
  console.log('VERIFYING GP VALUES FOR BIN 004740 (NY MEDICAID) AT HEIGHTS CHEMIST');
  console.log('='.repeat(90));

  // Get all triggers with their recommended drugs
  const triggers = await pool.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc, default_gp_value
    FROM triggers
    WHERE is_enabled = true AND recommended_drug IS NOT NULL
    ORDER BY default_gp_value DESC
  `);

  console.log(`\nChecking ${triggers.rows.length} triggers against BIN 004740 claims...\n`);

  const verified = [];
  const notFound = [];

  for (const trigger of triggers.rows) {
    const recDrug = (trigger.recommended_drug || '').toUpperCase();
    const recNdc = (trigger.recommended_ndc || '').replace(/-/g, '');

    // Extract keywords from recommended drug name
    const keywords = recDrug.split(/[\s,()-]+/).filter(w => w.length > 3);

    // Search for matching prescriptions on Medicaid BIN only
    let claims = [];

    // Try NDC match first
    if (recNdc && recNdc.length >= 10) {
      const ndcResult = await pool.query(`
        SELECT drug_name, ndc,
               COUNT(*) as rx_count,
               AVG(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as avg_gp,
               AVG(COALESCE(insurance_pay, 0)) as avg_ins_pay,
               AVG(COALESCE(acquisition_cost, 0)) as avg_acq_cost
        FROM prescriptions
        WHERE pharmacy_id = $1
          AND insurance_bin = $2
          AND REPLACE(ndc, '-', '') = $3
        GROUP BY drug_name, ndc
        ORDER BY rx_count DESC
      `, [pharmacyId, MEDICAID_BIN, recNdc]);
      claims = ndcResult.rows;
    }

    // If no NDC match, try keyword match
    if (claims.length === 0 && keywords.length > 0) {
      const keywordConditions = keywords.map((_, i) => `UPPER(drug_name) LIKE '%' || $${i + 3} || '%'`).join(' OR ');
      const keywordResult = await pool.query(`
        SELECT drug_name, ndc,
               COUNT(*) as rx_count,
               AVG(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as avg_gp,
               AVG(COALESCE(insurance_pay, 0)) as avg_ins_pay,
               AVG(COALESCE(acquisition_cost, 0)) as avg_acq_cost
        FROM prescriptions
        WHERE pharmacy_id = $1
          AND insurance_bin = $2
          AND (${keywordConditions})
        GROUP BY drug_name, ndc
        ORDER BY rx_count DESC
        LIMIT 5
      `, [pharmacyId, MEDICAID_BIN, ...keywords]);
      claims = keywordResult.rows;
    }

    if (claims.length > 0) {
      const totalRx = claims.reduce((sum, c) => sum + parseInt(c.rx_count), 0);
      const weightedAvgGp = claims.reduce((sum, c) => sum + (parseFloat(c.avg_gp || 0) * parseInt(c.rx_count)), 0) / totalRx;

      verified.push({
        trigger: trigger.display_name,
        recommendedDrug: trigger.recommended_drug,
        assumedGp: trigger.default_gp_value || 50,
        actualAvgGp: weightedAvgGp,
        difference: weightedAvgGp - (trigger.default_gp_value || 50),
        totalRx: totalRx,
        claims: claims.slice(0, 3)
      });
    } else {
      notFound.push({
        trigger: trigger.display_name,
        recommendedDrug: trigger.recommended_drug,
        assumedGp: trigger.default_gp_value || 50
      });
    }
  }

  // Display verified triggers
  console.log('='.repeat(90));
  console.log(`VERIFIED ON MEDICAID (Found ${verified.length} triggers with actual paid claims)`);
  console.log('='.repeat(90));
  console.log('Trigger'.padEnd(45) + ' | Assumed | Actual  | Diff     | Rx#');
  console.log('-'.repeat(90));

  // Sort by Rx count (most evidence first)
  verified.sort((a, b) => b.totalRx - a.totalRx);

  for (const v of verified) {
    const diffStr = v.difference >= 0 ? `+$${v.difference.toFixed(0)}` : `-$${Math.abs(v.difference).toFixed(0)}`;
    const status = Math.abs(v.difference) <= 20 ? '✓' : v.difference > 0 ? '📈' : '📉';
    console.log(
      v.trigger.substring(0, 43).padEnd(45),
      '|', ('$' + v.assumedGp).padStart(7),
      '|', ('$' + v.actualAvgGp.toFixed(0)).padStart(7),
      '|', diffStr.padStart(8),
      '|', String(v.totalRx).padStart(4),
      status
    );
  }

  // Detailed breakdown
  console.log('\n' + '='.repeat(90));
  console.log('DETAILED BREAKDOWN - VERIFIED MEDICAID CLAIMS');
  console.log('='.repeat(90));

  for (const v of verified.slice(0, 15)) {
    console.log(`\n${v.trigger}`);
    console.log(`  Recommended: ${v.recommendedDrug}`);
    console.log(`  Assumed GP: $${v.assumedGp} | Actual Avg GP: $${v.actualAvgGp.toFixed(2)}`);
    for (const c of v.claims) {
      console.log(`    → ${c.drug_name?.substring(0, 35) || 'N/A'}`);
      console.log(`      ${c.rx_count} fills | Avg GP: $${parseFloat(c.avg_gp || 0).toFixed(2)} | Avg Ins Pay: $${parseFloat(c.avg_ins_pay || 0).toFixed(2)} | Avg ACQ: $${parseFloat(c.avg_acq_cost || 0).toFixed(2)}`);
    }
  }

  // Not found
  console.log('\n' + '='.repeat(90));
  console.log(`NO MEDICAID CLAIMS FOUND (${notFound.length} triggers) - GP values are ASSUMED`);
  console.log('='.repeat(90));
  for (const nf of notFound) {
    console.log(`  ${nf.trigger.substring(0, 45).padEnd(47)} | ${(nf.recommendedDrug || '').substring(0, 25).padEnd(27)} | $${nf.assumedGp} (assumed)`);
  }

  // Summary
  console.log('\n' + '='.repeat(90));
  console.log('SUMMARY - BIN 004740 (NY MEDICAID)');
  console.log('='.repeat(90));
  console.log(`Triggers with VERIFIED Medicaid claims: ${verified.length}`);
  console.log(`Triggers with NO Medicaid claims (assumed GP): ${notFound.length}`);

  const totalVerifiedRx = verified.reduce((sum, v) => sum + v.totalRx, 0);
  console.log(`\nTotal verified Rx fills: ${totalVerifiedRx}`);

  const avgDiff = verified.reduce((sum, v) => sum + v.difference, 0) / verified.length;
  console.log(`Average GP difference: ${avgDiff >= 0 ? '+' : ''}$${avgDiff.toFixed(2)}`);

  // Calculate potential adjustment
  const overEstimatedValue = verified
    .filter(v => v.difference < -20)
    .reduce((sum, v) => sum + (Math.abs(v.difference) * v.totalRx * 12), 0);

  const underEstimatedValue = verified
    .filter(v => v.difference > 20)
    .reduce((sum, v) => sum + (v.difference * v.totalRx * 12), 0);

  console.log(`\nPotential annual adjustment based on actual vs assumed:`);
  console.log(`  Under-estimated (we're conservative): +$${underEstimatedValue.toLocaleString()}`);
  console.log(`  Over-estimated (we're optimistic): -$${overEstimatedValue.toLocaleString()}`);
  console.log(`  Net adjustment: $${(underEstimatedValue - overEstimatedValue).toLocaleString()}`);

  await pool.end();
}

verify().catch(console.error);
