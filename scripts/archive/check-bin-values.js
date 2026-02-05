import 'dotenv/config';
import db from './src/database/index.js';

const r = await db.query(`
  SELECT tbv.trigger_id, t.display_name, t.is_enabled, COUNT(*) as count
  FROM trigger_bin_values tbv
  LEFT JOIN triggers t ON t.trigger_id = tbv.trigger_id
  GROUP BY tbv.trigger_id, t.display_name, t.is_enabled
  ORDER BY t.display_name NULLS FIRST
`);

r.rows.forEach(row => {
  const status = row.display_name ? (row.is_enabled ? 'ON' : 'OFF') : 'NO TRIGGER';
  console.log(status, '|', row.display_name || row.trigger_id, '|', row.count, 'entries');
});

// Check for entries with no best_drug_name
const missing = await db.query(`
  SELECT tbv.insurance_bin, tbv.insurance_group, tbv.gp_value, tbv.best_drug_name, tbv.best_ndc, tbv.coverage_status,
         t.display_name
  FROM trigger_bin_values tbv
  LEFT JOIN triggers t ON t.trigger_id = tbv.trigger_id
  WHERE tbv.best_drug_name IS NULL AND tbv.coverage_status = 'verified'
  LIMIT 20
`);

console.log('\n--- Verified entries missing drug name ---');
missing.rows.forEach(row => {
  console.log(row.display_name, '|', row.insurance_bin, '/', row.insurance_group, '| GP:', row.gp_value, '| Drug:', row.best_drug_name, '| NDC:', row.best_ndc);
});

process.exit(0);
