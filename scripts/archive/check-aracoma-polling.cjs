const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Get Aracoma pharmacy info
    const pharm = await pool.query(`
      SELECT pharmacy_id, pharmacy_name, settings
      FROM pharmacies
      WHERE pharmacy_name ILIKE '%aracoma%'
    `);

    if (pharm.rows.length === 0) {
      console.log('Aracoma not found');
      await pool.end();
      return;
    }

    const aracoma = pharm.rows[0];
    console.log('Aracoma Pharmacy:');
    console.log('  ID:', aracoma.pharmacy_id);
    console.log('  Settings:', JSON.stringify(aracoma.settings, null, 2));

    // Check processed emails
    const emails = await pool.query(`
      SELECT message_id, subject, received_date, processed_at, source
      FROM processed_emails
      WHERE pharmacy_id = $1
      ORDER BY received_date DESC
      LIMIT 10
    `, [aracoma.pharmacy_id]);

    console.log('\nRecent processed emails:');
    if (emails.rows.length === 0) {
      console.log('  None found');
    } else {
      emails.rows.forEach(e => {
        console.log('  ---');
        console.log('  Subject:', e.subject);
        console.log('  Received:', e.received_date);
        console.log('  Processed:', e.processed_at);
        console.log('  Source:', e.source);
      });
    }

    // Check prescription count and recent dates
    const rxStats = await pool.query(`
      SELECT
        COUNT(*) as total,
        MAX(dispensed_date) as latest_rx,
        MIN(dispensed_date) as earliest_rx,
        MAX(created_at) as last_ingested
      FROM prescriptions
      WHERE pharmacy_id = $1
    `, [aracoma.pharmacy_id]);

    console.log('\nPrescription stats:');
    console.log('  Total Rxs:', rxStats.rows[0].total);
    console.log('  Latest Rx date:', rxStats.rows[0].latest_rx);
    console.log('  Earliest Rx date:', rxStats.rows[0].earliest_rx);
    console.log('  Last ingested at:', rxStats.rows[0].last_ingested);

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
