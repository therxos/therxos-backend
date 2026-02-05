require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Fix first_name - remove (BP), asterisks, etc.
  const result1 = await pool.query(`
    UPDATE patients
    SET first_name = TRIM(REGEXP_REPLACE(REGEXP_REPLACE(first_name, E'\\\\([^)]*\\\\)', '', 'g'), E'\\\\*+', '', 'g'))
    WHERE first_name ~ E'\\\\(' OR first_name ~ E'\\\\*'
    RETURNING patient_id
  `);
  console.log('Fixed first_name for ' + result1.rowCount + ' patients');

  // Fix last_name
  const result2 = await pool.query(`
    UPDATE patients
    SET last_name = TRIM(REGEXP_REPLACE(REGEXP_REPLACE(last_name, E'\\\\([^)]*\\\\)', '', 'g'), E'\\\\*+', '', 'g'))
    WHERE last_name ~ E'\\\\(' OR last_name ~ E'\\\\*'
    RETURNING patient_id
  `);
  console.log('Fixed last_name for ' + result2.rowCount + ' patients');

  // Check for remaining dirty names
  const remaining = await pool.query(`
    SELECT COUNT(*) as cnt FROM patients
    WHERE first_name ~ '[()\\*]' OR last_name ~ '[()\\*]'
  `);
  console.log('Remaining patients with dirty names: ' + remaining.rows[0].cnt);

  await pool.end();
}
run().catch(e => console.error(e));
