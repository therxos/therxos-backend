import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Check for DB triggers on the triggers table
  const triggers = await pool.query(`
    SELECT tgname, tgtype, pg_get_triggerdef(t.oid) as definition
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'triggers'
    AND NOT t.tgisinternal
  `);
  console.log('DB triggers on "triggers" table:');
  triggers.rows.forEach(r => {
    console.log(`  ${r.tgname}: ${r.definition}`);
  });

  // Check for trigger functions that mention "Cannot delete trigger"
  const funcs = await pool.query(`
    SELECT proname, prosrc
    FROM pg_proc
    WHERE prosrc ILIKE '%cannot delete trigger%'
    OR prosrc ILIKE '%actioned opportunit%'
  `);
  console.log('\nFunctions mentioning "cannot delete trigger" or "actioned opportunit":');
  funcs.rows.forEach(r => {
    console.log(`  Function: ${r.proname}`);
    console.log(`  Source: ${r.prosrc}`);
    console.log('---');
  });

  // Also check FK constraints on triggers table
  const fks = await pool.query(`
    SELECT
      tc.table_name as referencing_table,
      kcu.column_name as referencing_column,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name
    WHERE ccu.table_name = 'triggers'
    AND tc.constraint_type = 'FOREIGN KEY'
  `);
  console.log('\nFK constraints referencing "triggers" table:');
  fks.rows.forEach(r => {
    console.log(`  ${r.referencing_table}.${r.referencing_column} → ON DELETE: ${r.delete_rule}`);
  });

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
