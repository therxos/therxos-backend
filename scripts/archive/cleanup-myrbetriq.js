import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const trigger = await pool.query(`
    SELECT trigger_id FROM triggers WHERE display_name ILIKE '%myrbetriq%'
  `);

  if (trigger.rows.length === 0) {
    console.log('No Myrbetriq trigger found');
    return;
  }

  const triggerId = trigger.rows[0].trigger_id;

  // Only delete "Not Submitted" opportunities (respect the critical rule)
  const result = await pool.query(`
    DELETE FROM opportunities
    WHERE trigger_id = $1 AND status = 'Not Submitted'
    RETURNING opportunity_id
  `, [triggerId]);

  console.log(`Deleted ${result.rowCount} bogus Myrbetriq opportunities (all "Not Submitted")`);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
