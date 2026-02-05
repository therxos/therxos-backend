import db from './src/database/index.js';

async function check() {
  const result = await db.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'trigger_bin_values'
    ORDER BY ordinal_position
  `);
  console.log('trigger_bin_values columns:');
  result.rows.forEach(r => console.log(`  ${r.column_name}: ${r.data_type}`));
  process.exit(0);
}
check();
