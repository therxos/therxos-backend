const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // First, set gmail_polling_enabled = false for ALL pharmacies (safety reset)
    await pool.query(`
      UPDATE pharmacies
      SET settings = COALESCE(settings, '{}'::jsonb) || '{"gmail_polling_enabled": false}'::jsonb
    `);
    console.log('Reset all pharmacies to gmail_polling_enabled = false');

    // Now enable ONLY for Bravo and Noor
    const enabled = await pool.query(`
      UPDATE pharmacies
      SET settings = COALESCE(settings, '{}'::jsonb) || '{"gmail_polling_enabled": true}'::jsonb
      WHERE pharmacy_name IN ('Bravo Pharmacy', 'Noor Pharmacy')
      RETURNING pharmacy_name
    `);
    console.log('Enabled Gmail polling for:', enabled.rows.map(r => r.pharmacy_name));

    // Verify
    const verify = await pool.query(`
      SELECT pharmacy_name, settings->>'gmail_polling_enabled' as enabled
      FROM pharmacies
      ORDER BY pharmacy_name
    `);
    console.log('\nAll pharmacies Gmail polling status:');
    verify.rows.forEach(r => console.log(`  ${r.pharmacy_name}: ${r.enabled}`));

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
