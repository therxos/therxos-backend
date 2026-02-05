import 'dotenv/config';
import db from './src/database/index.js';

const PARKWAY = 'f0bd945a-836d-422b-8e58-ceb4dda0a12a';

// 1. Check Parkway's top BINs
const bins = await db.query(`
  SELECT insurance_bin, insurance_group, COUNT(*) as rx_count
  FROM prescriptions
  WHERE pharmacy_id = $1
    AND dispensed_date > NOW() - INTERVAL '90 days'
    AND insurance_bin IS NOT NULL
  GROUP BY insurance_bin, insurance_group
  ORDER BY rx_count DESC
  LIMIT 15
`, [PARKWAY]);
console.log('=== Parkway Top BINs ===');
for (const r of bins.rows) {
  console.log('BIN:', r.insurance_bin, '| GROUP:', r.insurance_group, '| rxs:', r.rx_count);
}

// 2. Check how many Parkway opps now have trigger_id
const oppStats = await db.query(`
  SELECT
    COUNT(*) as total,
    COUNT(trigger_id) as with_trigger,
    COUNT(*) - COUNT(trigger_id) as without_trigger
  FROM opportunities
  WHERE pharmacy_id = $1 AND status = 'Not Submitted'
`, [PARKWAY]);
console.log('\n=== Parkway Opp Stats ===');
console.log(oppStats.rows[0]);

// 3. Sample a Parkway opp WITH trigger_id and check if its BIN has trigger_bin_values
const sample = await db.query(`
  SELECT o.opportunity_id, o.trigger_id, o.recommended_drug_name,
    pr.insurance_bin, pr.insurance_group,
    t.display_name as trigger_name
  FROM opportunities o
  LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
  LEFT JOIN triggers t ON t.trigger_id = o.trigger_id
  WHERE o.pharmacy_id = $1
    AND o.trigger_id IS NOT NULL
    AND o.status = 'Not Submitted'
  LIMIT 5
`, [PARKWAY]);
console.log('\n=== Sample Parkway opps with trigger_id ===');
for (const s of sample.rows) {
  console.log('Trigger:', s.trigger_name, '| BIN:', s.insurance_bin, '| GROUP:', s.insurance_group);

  // Check trigger_bin_values for this combo
  const tbv = await db.query(`
    SELECT insurance_bin, insurance_group, coverage_status, gp_value, verified_claim_count
    FROM trigger_bin_values
    WHERE trigger_id = $1
    ORDER BY verified_claim_count DESC NULLS LAST
    LIMIT 5
  `, [s.trigger_id]);
  if (tbv.rows.length === 0) {
    console.log('  -> NO trigger_bin_values entries at all');
  } else {
    console.log('  -> trigger_bin_values entries:');
    for (const t of tbv.rows) {
      console.log('     BIN:', t.insurance_bin, '| GROUP:', t.insurance_group, '| status:', t.coverage_status, '| claims:', t.verified_claim_count);
    }
    // Check specific match
    const exact = tbv.rows.find(t => t.insurance_bin === s.insurance_bin && (t.insurance_group || '') === (s.insurance_group || ''));
    const binOnly = tbv.rows.find(t => t.insurance_bin === s.insurance_bin);
    console.log('  -> Exact BIN+GROUP match:', exact ? 'YES' : 'NO');
    console.log('  -> BIN-only match:', binOnly ? 'YES' : 'NO');
  }
}

// 4. Total trigger_bin_values entries
const tbvCount = await db.query(`SELECT COUNT(*) as count FROM trigger_bin_values`);
console.log('\n=== Total trigger_bin_values entries:', tbvCount.rows[0].count, '===');

// 5. Check how many trigger_bin_values are verified/works
const tbvStatus = await db.query(`
  SELECT coverage_status, COUNT(*) as count
  FROM trigger_bin_values
  GROUP BY coverage_status
  ORDER BY count DESC
`);
console.log('\n=== trigger_bin_values by status ===');
for (const r of tbvStatus.rows) {
  console.log(r.coverage_status, ':', r.count);
}

process.exit(0);
