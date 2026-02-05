const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

    const result = await pool.query(`
      SELECT pharmacy_name, settings, fax
      FROM pharmacies
      WHERE pharmacy_id = $1
    `, [heightsId]);

    console.log('Heights Chemist settings:');
    console.log('Pharmacy:', result.rows[0].pharmacy_name);
    console.log('Fax number:', result.rows[0].fax);
    console.log('Settings:', JSON.stringify(result.rows[0].settings, null, 2));
    console.log('faxEnabled:', result.rows[0].settings?.faxEnabled);

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
