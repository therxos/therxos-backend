require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Count before
  const before = await pool.query(`SELECT COUNT(*) as cnt FROM opportunities WHERE status = 'Not Submitted'`);
  console.log('Not Submitted opportunities before: ' + before.rows[0].cnt);

  // Delete Not Submitted duplicates, keeping the one with highest annual_margin_gain
  const result = await pool.query(`
    WITH ranked AS (
      SELECT
        opportunity_id,
        ROW_NUMBER() OVER (
          PARTITION BY pharmacy_id, patient_id, UPPER(COALESCE(recommended_drug_name, ''))
          ORDER BY annual_margin_gain DESC NULLS LAST, created_at ASC
        ) as rn
      FROM opportunities
      WHERE status = 'Not Submitted'
    )
    DELETE FROM opportunities
    WHERE opportunity_id IN (
      SELECT opportunity_id FROM ranked WHERE rn > 1
    )
    AND status = 'Not Submitted'
    RETURNING opportunity_id
  `);

  console.log('Deleted: ' + result.rowCount + ' Not Submitted duplicates');

  // Count after
  const after = await pool.query(`SELECT COUNT(*) as cnt FROM opportunities WHERE status = 'Not Submitted'`);
  console.log('Not Submitted opportunities after: ' + after.rows[0].cnt);

  // Check remaining duplicates (any status)
  const remaining = await pool.query(`
    SELECT COUNT(*) as cnt FROM (
      SELECT pharmacy_id, patient_id, UPPER(COALESCE(recommended_drug_name, ''))
      FROM opportunities
      WHERE status NOT IN ('Denied', 'Declined')
      GROUP BY 1, 2, 3
      HAVING COUNT(*) > 1
    ) x
  `);
  console.log('\nRemaining duplicate groups (includes actioned): ' + remaining.rows[0].cnt);

  await pool.end();
}

run().catch(e => console.error(e));
