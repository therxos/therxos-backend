const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const aracomaId = '5b77e7f0-66c0-4f1b-b307-deeed69354c9';

    // Check recent prescriptions for Aracoma
    const result = await pool.query(`
      SELECT
        DATE(created_at) as import_date,
        COUNT(*) as rx_count,
        COUNT(DISTINCT patient_id) as patient_count,
        source_file
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND created_at >= NOW() - INTERVAL '10 days'
      GROUP BY DATE(created_at), source_file
      ORDER BY import_date DESC
    `, [aracomaId]);

    console.log('Aracoma prescriptions in last 10 days:');
    if (result.rows.length === 0) {
      console.log('  NO NEW DATA IN LAST 10 DAYS');
    } else {
      result.rows.forEach(r => {
        console.log(`  ${r.import_date}: ${r.rx_count} Rxs, ${r.patient_count} patients, file: ${r.source_file || 'null'}`);
      });
    }

    // Check poll_runs for Aracoma
    const polls = await pool.query(`
      SELECT run_type, started_at, completed_at, status, summary
      FROM poll_runs
      WHERE pharmacy_id = $1
      ORDER BY started_at DESC
      LIMIT 5
    `, [aracomaId]);

    console.log('\nRecent poll runs for Aracoma:');
    if (polls.rows.length === 0) {
      console.log('  No poll runs found');
    } else {
      polls.rows.forEach(r => {
        console.log(`  ${r.run_type} at ${r.started_at} - ${r.status}`);
      });
    }

    // Check processed_emails for Aracoma
    const emails = await pool.query(`
      SELECT message_id, processed_at, subject
      FROM processed_emails
      WHERE pharmacy_id = $1
      ORDER BY processed_at DESC
      LIMIT 5
    `, [aracomaId]);

    console.log('\nRecent processed emails for Aracoma:');
    if (emails.rows.length === 0) {
      console.log('  No processed emails found');
    } else {
      emails.rows.forEach(r => {
        console.log(`  ${r.processed_at}: ${r.subject || '(no subject)'}`);
      });
    }

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
