import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Check FK constraints on opportunities table (what references opportunities?)
  const fks = await pool.query(`
    SELECT
      tc.table_name,
      kcu.column_name,
      rc.delete_rule,
      ccu.column_name as referenced_column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
    JOIN information_schema.constraint_column_usage ccu ON rc.unique_constraint_name = ccu.constraint_name
    WHERE ccu.table_name = 'opportunities'
    AND tc.constraint_type = 'FOREIGN KEY'
  `);
  console.log('Tables referencing opportunities:');
  fks.rows.forEach(r => console.log(`  ${r.table_name}.${r.column_name} → opportunities.${r.referenced_column} (ON DELETE: ${r.delete_rule})`));

  // Try to simulate a delete — pick a trigger with only 'Not Submitted' opps
  const candidate = await pool.query(`
    SELECT t.trigger_id, t.display_name,
      COUNT(*) FILTER (WHERE o.status = 'Not Submitted') as unactioned,
      COUNT(*) FILTER (WHERE o.status != 'Not Submitted') as actioned
    FROM triggers t
    LEFT JOIN opportunities o ON o.trigger_id = t.trigger_id
    GROUP BY t.trigger_id, t.display_name
    HAVING COUNT(*) FILTER (WHERE o.status != 'Not Submitted') = 0
    AND COUNT(*) > 0
    ORDER BY COUNT(*) ASC
    LIMIT 3
  `);
  console.log('\nTriggers with ONLY unactioned opps (safe to delete):');
  candidate.rows.forEach(r => console.log(`  ${r.display_name}: ${r.unactioned} unactioned, ${r.actioned} actioned`));

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
