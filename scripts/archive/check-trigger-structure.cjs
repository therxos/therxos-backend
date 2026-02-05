const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Check triggers table structure
    const cols = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'triggers'
      ORDER BY ordinal_position
    `);

    console.log('Triggers table columns:');
    cols.rows.forEach(r => console.log('  ' + r.column_name));

    // Sample triggers for missing_therapy
    const triggers = await pool.query(`
      SELECT *
      FROM triggers
      WHERE trigger_type IN ('missing_therapy', 'combo_therapy')
      LIMIT 5
    `);

    console.log('\n\nSample Missing/Combo Therapy Triggers:');
    triggers.rows.forEach(t => {
      console.log('---');
      console.log(JSON.stringify(t, null, 2));
    });

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
