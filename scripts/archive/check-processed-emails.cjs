require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check processed emails
  const emails = await pool.query(`
    SELECT e.message_id, e.pharmacy_id, e.processed_at, e.results, p.pharmacy_name
    FROM processed_emails e
    LEFT JOIN pharmacies p ON p.pharmacy_id = e.pharmacy_id
    ORDER BY e.processed_at DESC
    LIMIT 15
  `);

  console.log('Recent processed emails:');
  for (const e of emails.rows) {
    const r = e.results || {};
    console.log(e.processed_at.toISOString().slice(0,10) + ' | ' + (e.pharmacy_name || 'unknown').slice(0,15).padEnd(15) + ' | records: ' + (r.recordsIngested || 0).toString().padEnd(5) + ' | completed: ' + (r.opportunitiesCompleted || 0));
    if (r.errors && r.errors.length > 0) {
      console.log('    Errors: ' + JSON.stringify(r.errors).slice(0,100));
    }
    if (r.debug && r.debug.length > 0) {
      for (const d of r.debug) {
        console.log('    File: ' + d.filename + ' | total: ' + d.totalRecords + ' | inserted: ' + d.inserted + ' | dupes: ' + d.duplicates);
      }
    }
  }

  await pool.end();
}
check().catch(e => console.error(e));
