import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Check trigger category + type for BP monitor and spacer
  const triggers = await pool.query(`
    SELECT trigger_id, display_name, trigger_type, category
    FROM triggers
    WHERE LOWER(display_name) LIKE '%blood pressure%'
       OR LOWER(display_name) LIKE '%spacer%'
       OR LOWER(display_name) LIKE '%bp monitor%'
       OR LOWER(display_name) LIKE '%pen needle%'
    ORDER BY category, display_name
  `);
  console.log('Relevant triggers:');
  triggers.rows.forEach(r => console.log(`  [cat: ${r.category}, type: ${r.trigger_type}] ${r.display_name} (${r.trigger_id.slice(0,8)})`));

  // All distinct category values
  const cats = await pool.query(`
    SELECT category, COUNT(*) as cnt
    FROM triggers
    GROUP BY category
    ORDER BY category
  `);
  console.log('\nAll trigger categories:');
  cats.rows.forEach(r => console.log(`  ${r.category}: ${r.cnt} triggers`));

  // All distinct trigger_type values
  const types = await pool.query(`
    SELECT trigger_type, COUNT(*) as cnt
    FROM triggers
    GROUP BY trigger_type
    ORDER BY trigger_type
  `);
  console.log('\nAll trigger types:');
  types.rows.forEach(r => console.log(`  ${r.trigger_type}: ${r.cnt} triggers`));

  // Check what column opportunities use for category
  const oppCols = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'opportunities'
    AND column_name LIKE '%categ%' OR column_name LIKE '%trigger%' OR column_name LIKE '%type%'
    ORDER BY ordinal_position
  `);
  console.log('\nOpportunity category/type columns:', oppCols.rows.map(r => r.column_name).join(', '));

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
