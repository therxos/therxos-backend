import 'dotenv/config';
import db from './src/database/index.js';

async function runDeduplication() {
  try {
    console.log('Running deduplication preview...\n');

    // First, run in dry-run mode to see what would be removed
    const preview = await db.query(`
      SELECT * FROM deduplicate_patient_opportunities(NULL, true)
    `);

    if (preview.rows.length === 0) {
      console.log('No duplicates found to clean up.');
      process.exit(0);
    }

    console.log(`Found ${preview.rows.length} patients with duplicates:\n`);

    let totalRemoved = 0;
    for (const row of preview.rows) {
      console.log(`Patient: ${row.patient_name}`);
      console.log(`  Category: ${row.category}`);
      console.log(`  Before: ${row.opportunities_before} → After: ${row.opportunities_after}`);
      console.log(`  Keeping: ${row.kept_drug} (${row.kept_value ? '$' + parseFloat(row.kept_value).toFixed(2) : 'N/A'})`);
      console.log(`  Removing: ${row.removed_count} duplicates`);
      console.log('---');
      totalRemoved += row.removed_count;
    }

    console.log(`\nTotal duplicates to remove: ${totalRemoved}`);
    console.log('\nRunning actual deduplication...\n');

    // Now run for real
    const result = await db.query(`
      SELECT * FROM deduplicate_patient_opportunities(NULL, false)
    `);

    console.log(`Deduplication complete! Processed ${result.rows.length} patients.`);

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

runDeduplication();
