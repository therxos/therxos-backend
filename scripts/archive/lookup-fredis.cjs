require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const result = await pool.query(`
    SELECT
      p.pharmacy_name,
      pat.first_name,
      pat.last_name,
      pat.dob,
      pat.patient_id
    FROM patients pat
    JOIN pharmacies p ON p.pharmacy_id = pat.pharmacy_id
    WHERE pat.first_name ILIKE '%fredis%' OR pat.last_name ILIKE '%brea%'
    LIMIT 10
  `);

  console.log('Fredis Brea lookup:');
  for (const r of result.rows) {
    console.log(`${r.pharmacy_name} | ${r.first_name} ${r.last_name} | DOB: ${r.dob} | ID: ${r.patient_id}`);
  }

  await pool.end();
}
run();
