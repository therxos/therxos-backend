const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Get column names for processed_emails
    const cols = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'processed_emails'
    `);
    console.log('processed_emails columns:', cols.rows.map(r => r.column_name));

    // Get Aracoma
    const pharm = await pool.query(`
      SELECT pharmacy_id, pharmacy_name, settings
      FROM pharmacies
      WHERE pharmacy_name ILIKE '%aracoma%'
    `);
    const aracoma = pharm.rows[0];
    console.log('\nAracoma ID:', aracoma.pharmacy_id);
    console.log('microsoft_polling_enabled:', aracoma.settings?.microsoft_polling_enabled);

    // Check processed emails with correct columns
    const emails = await pool.query(`
      SELECT *
      FROM processed_emails
      WHERE pharmacy_id = $1
      ORDER BY processed_at DESC
      LIMIT 5
    `, [aracoma.pharmacy_id]);

    console.log('\nProcessed emails:', emails.rows.length);
    emails.rows.forEach(e => {
      console.log('  ---');
      console.log('  ', JSON.stringify(e, null, 2));
    });

    // Check prescription stats
    const rxStats = await pool.query(`
      SELECT
        COUNT(*) as total,
        MAX(dispensed_date) as latest_rx,
        MAX(created_at) as last_ingested
      FROM prescriptions
      WHERE pharmacy_id = $1
    `, [aracoma.pharmacy_id]);

    console.log('\nPrescription stats:');
    console.log('  Total Rxs:', rxStats.rows[0].total);
    console.log('  Latest Rx date:', rxStats.rows[0].latest_rx);
    console.log('  Last ingested at:', rxStats.rows[0].last_ingested);

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
