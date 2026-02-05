/**
 * Remove fake MEDICARE: prefix entries from trigger_bin_values.
 * These were created by run-medicare-coverage-scan.js and store
 * estimated patient copay as gp_value (from tier lookup), not actual GP.
 */
import 'dotenv/config';
import db from './src/database/index.js';

async function cleanup() {
  console.log('=== CLEANUP FAKE MEDICARE ENTRIES ===\n');

  // Count them first
  const countResult = await db.query(`
    SELECT COUNT(*) as total,
           COUNT(DISTINCT trigger_id) as triggers_affected
    FROM trigger_bin_values
    WHERE insurance_bin LIKE 'MEDICARE:%'
  `);
  console.log(`Found ${countResult.rows[0].total} MEDICARE: entries across ${countResult.rows[0].triggers_affected} triggers`);

  // Show a sample
  const sampleResult = await db.query(`
    SELECT insurance_bin, insurance_group, gp_value, coverage_status, best_drug_name
    FROM trigger_bin_values
    WHERE insurance_bin LIKE 'MEDICARE:%'
    ORDER BY gp_value DESC
    LIMIT 5
  `);
  console.log('\nSample entries being removed:');
  for (const r of sampleResult.rows) {
    console.log(`  ${r.insurance_bin}/${r.insurance_group || ''} - $${r.gp_value} (${r.coverage_status}) ${r.best_drug_name || ''}`);
  }

  // Delete them
  const deleteResult = await db.query(`
    DELETE FROM trigger_bin_values
    WHERE insurance_bin LIKE 'MEDICARE:%'
    RETURNING trigger_id
  `);
  console.log(`\nDeleted ${deleteResult.rows.length} fake MEDICARE entries`);

  // Verify
  const verifyResult = await db.query(`
    SELECT COUNT(*) FROM trigger_bin_values WHERE insurance_bin LIKE 'MEDICARE:%'
  `);
  console.log(`Remaining MEDICARE entries: ${verifyResult.rows[0].count}`);

  process.exit(0);
}

cleanup().catch(e => {
  console.error('Cleanup failed:', e);
  process.exit(1);
});
