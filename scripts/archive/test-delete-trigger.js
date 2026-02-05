import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Check the Myrbetriq trigger (which should have 0 opportunities now)
  const trigger = await pool.query(`
    SELECT trigger_id, display_name FROM triggers WHERE display_name ILIKE '%myrbetriq%'
  `);

  if (trigger.rows.length > 0) {
    const t = trigger.rows[0];
    console.log(`Found: ${t.display_name} (${t.trigger_id})`);

    // Check if it has any opportunities
    const opps = await pool.query(`
      SELECT COUNT(*) as cnt FROM opportunities WHERE trigger_id = $1
    `, [t.trigger_id]);
    console.log(`Opportunities: ${opps.rows[0].cnt}`);

    // Check foreign key constraint on opportunities table
    const fk = await pool.query(`
      SELECT tc.constraint_name, tc.table_name, kcu.column_name,
             ccu.table_name AS foreign_table_name,
             rc.delete_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
      JOIN information_schema.referential_constraints AS rc ON rc.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND kcu.column_name = 'trigger_id'
    `);
    console.log('\nForeign key constraints on trigger_id:');
    for (const r of fk.rows) {
      console.log(`  ${r.table_name}.${r.column_name} -> ${r.foreign_table_name} (ON DELETE: ${r.delete_rule})`);
    }

    // Try a test delete (won't actually run if there are constraints)
    try {
      // Don't actually delete - just check if it would work
      await pool.query('BEGIN');
      await pool.query('DELETE FROM triggers WHERE trigger_id = $1', [t.trigger_id]);
      console.log('\nDelete would succeed');
      await pool.query('ROLLBACK');
    } catch (err) {
      console.log(`\nDelete would FAIL: ${err.message}`);
      await pool.query('ROLLBACK');
    }
  } else {
    console.log('No Myrbetriq trigger found');
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
