import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Find all foreign keys referencing triggers table
  const fks = await pool.query(`
    SELECT
      tc.table_name,
      kcu.column_name,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name
    WHERE ccu.table_name = 'triggers'
    AND tc.constraint_type = 'FOREIGN KEY'
  `);
  console.log('Tables referencing triggers:');
  fks.rows.forEach(r => console.log(`  ${r.table_name}.${r.column_name} (ON DELETE: ${r.delete_rule})`));

  // Try a test delete on a disabled trigger with no opps
  const testTrigger = await pool.query(`
    SELECT t.trigger_id, t.display_name, t.is_enabled,
      (SELECT COUNT(*) FROM opportunities WHERE trigger_id = t.trigger_id) as opp_count
    FROM triggers t
    WHERE t.is_enabled = false
    ORDER BY t.display_name
    LIMIT 5
  `);
  console.log('\nDisabled triggers:');
  testTrigger.rows.forEach(r => console.log(`  ${r.display_name}: ${r.opp_count} opps, enabled=${r.is_enabled}`));

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
