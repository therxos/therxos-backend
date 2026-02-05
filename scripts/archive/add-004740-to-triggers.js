import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Get triggers without 004740 pricing
const triggers = await db.query(`
  SELECT t.trigger_id, t.display_name, t.default_gp_value
  FROM triggers t
  WHERE t.is_enabled = true
  AND t.trigger_id NOT IN (
    SELECT trigger_id FROM trigger_bin_values WHERE insurance_bin = '004740'
  )
`);

console.log('Adding 004740 pricing to ' + triggers.rowCount + ' triggers...');

for (const t of triggers.rows) {
  // Use default GP or a reasonable Medicaid value
  const gpValue = t.default_gp_value || 50;
  
  await db.query(`
    INSERT INTO trigger_bin_values (trigger_id, insurance_bin, gp_value, is_excluded)
    VALUES ($1, '004740', $2, false)
    ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, '')) DO UPDATE SET gp_value = $2
  `, [t.trigger_id, gpValue]);
  
  console.log('  Added 004740 to: ' + t.display_name + ' ($' + gpValue + ')');
}

console.log('\nDone! Now rescan to pick up new opportunities.');
await db.end();
