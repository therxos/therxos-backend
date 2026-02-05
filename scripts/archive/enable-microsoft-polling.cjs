const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Enable microsoft_polling_enabled for Aracoma
    const result = await pool.query(`
      UPDATE pharmacies
      SET settings = COALESCE(settings, '{}'::jsonb) || '{"microsoft_polling_enabled": true}'::jsonb
      WHERE pharmacy_name ILIKE '%aracoma%'
      RETURNING pharmacy_name, settings
    `);

    console.log('Enabled Microsoft polling for:');
    result.rows.forEach(r => {
      console.log('  ', r.pharmacy_name);
      console.log('    Settings:', JSON.stringify(r.settings, null, 4));
    });

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
