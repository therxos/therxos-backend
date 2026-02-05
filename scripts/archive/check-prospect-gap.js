import 'dotenv/config';
import db from './src/database/index.js';

// Check trigger default_gp_values
const triggers = await db.query('SELECT display_name, default_gp_value, trigger_type FROM triggers WHERE is_enabled = true ORDER BY display_name');
console.log('=== Trigger default_gp_values ===');
let nullCount = 0;
for (const t of triggers.rows) {
  const gp = t.default_gp_value;
  if (!gp) nullCount++;
  console.log(t.display_name, '| default_gp:', gp || 'NULL ($50 fallback)', '| type:', t.trigger_type);
}
console.log('\nTotal triggers:', triggers.rows.length, '| NULL default_gp:', nullCount);

// What does the main scanner actually generate for Parkway?
const parkwayAvg = await db.query(`
  SELECT
    ROUND(AVG(potential_margin_gain)::numeric, 2) as avg_monthly_gp,
    ROUND(AVG(annual_margin_gain)::numeric, 2) as avg_annual_gp,
    ROUND(SUM(annual_margin_gain)::numeric, 2) as total_annual,
    COUNT(*) as opp_count
  FROM opportunities
  WHERE pharmacy_id = 'f0bd945a-836d-422b-8e58-ceb4dda0a12a'
    AND status = 'Not Submitted'
`);
console.log('\n=== Parkway Main Scanner Results ===');
console.log(parkwayAvg.rows[0]);

// What would the prospect scanner calculate? (default_gp * 12 * opp_count)
const prospectEstimate = triggers.rows.reduce((sum, t) => sum + (t.default_gp_value || 50), 0);
console.log('\nSum of all default_gp_values:', prospectEstimate);
console.log('If each trigger matches ~40 patients, prospect estimate:', prospectEstimate * 40 * 12);

// Top 10 Parkway opps by GP to show the spread
const topOpps = await db.query(`
  SELECT recommended_drug_name, potential_margin_gain, annual_margin_gain
  FROM opportunities
  WHERE pharmacy_id = 'f0bd945a-836d-422b-8e58-ceb4dda0a12a'
    AND status = 'Not Submitted'
  ORDER BY potential_margin_gain DESC
  LIMIT 10
`);
console.log('\n=== Top 10 Parkway opps by monthly GP ===');
for (const r of topOpps.rows) {
  console.log(r.recommended_drug_name, '| monthly:', r.potential_margin_gain, '| annual:', r.annual_margin_gain);
}

process.exit(0);
