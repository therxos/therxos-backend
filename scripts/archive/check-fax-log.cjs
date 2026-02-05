const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

    const logs = await pool.query(`
      SELECT fax_id, prescriber_name, fax_status, failed_reason, sent_at
      FROM fax_log
      WHERE pharmacy_id = $1
      ORDER BY sent_at DESC
      LIMIT 5
    `, [heightsId]);

    console.log('Recent fax attempts at Heights:');
    logs.rows.forEach(r => {
      console.log('---');
      console.log('Prescriber:', r.prescriber_name);
      console.log('Status:', r.fax_status);
      console.log('Failed Reason:', r.failed_reason || 'N/A');
      console.log('Sent:', r.sent_at);
    });

    if (logs.rows.length === 0) {
      console.log('No fax attempts found.');
    }

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
