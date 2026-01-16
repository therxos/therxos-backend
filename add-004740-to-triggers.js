import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function addBin004740() {
  console.log('Adding BIN 004740 to triggers...\n');

  // Get all enabled triggers that don't have 004740 configured
  const triggers = await pool.query(`
    SELECT t.trigger_id, t.display_name, t.default_gp_value
    FROM triggers t
    WHERE t.is_enabled = true
      AND NOT EXISTS (
        SELECT 1 FROM trigger_bin_values tbv
        WHERE tbv.trigger_id = t.trigger_id AND tbv.insurance_bin = '004740'
      )
  `);

  console.log(`Found ${triggers.rows.length} triggers without BIN 004740\n`);

  let added = 0;
  for (const trigger of triggers.rows) {
    const gpValue = trigger.default_gp_value || 50;

    // Check if already exists
    const exists = await pool.query(`
      SELECT id FROM trigger_bin_values
      WHERE trigger_id = $1 AND insurance_bin = '004740'
    `, [trigger.trigger_id]);

    if (exists.rows.length === 0) {
      await pool.query(`
        INSERT INTO trigger_bin_values (trigger_id, insurance_bin, gp_value, is_excluded)
        VALUES ($1, '004740', $2, false)
      `, [trigger.trigger_id, gpValue]);
    }

    console.log(`+ ${trigger.display_name.substring(0, 50).padEnd(50)} | GP: $${gpValue}`);
    added++;
  }

  console.log(`\n✅ Added BIN 004740 to ${added} triggers`);

  // Now show the count of triggers with 004740
  const verifyResult = await pool.query(`
    SELECT COUNT(*) as cnt FROM trigger_bin_values WHERE insurance_bin = '004740'
  `);
  console.log(`Total trigger BIN 004740 configurations: ${verifyResult.rows[0].cnt}`);

  await pool.end();
}

addBin004740().catch(console.error);
