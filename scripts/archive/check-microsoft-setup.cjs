const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Check if Microsoft OAuth is configured
    const tokenResult = await pool.query(`
      SELECT setting_key, updated_at,
             CASE WHEN token_data IS NOT NULL THEN 'configured' ELSE 'not configured' END as status
      FROM system_settings
      WHERE setting_key = 'microsoft_oauth_tokens'
    `);

    console.log('Microsoft OAuth Status:');
    if (tokenResult.rows.length === 0) {
      console.log('  NOT CONFIGURED - No tokens in system_settings');
    } else {
      console.log('  Status:', tokenResult.rows[0].status);
      console.log('  Last updated:', tokenResult.rows[0].updated_at);
    }

    // Check Aracoma's settings
    const aracomaResult = await pool.query(`
      SELECT pharmacy_name, settings, pms_system
      FROM pharmacies
      WHERE pharmacy_name ILIKE '%aracoma%'
    `);

    console.log('\nAracoma Pharmacy Settings:');
    if (aracomaResult.rows.length > 0) {
      const p = aracomaResult.rows[0];
      console.log('  PMS System:', p.pms_system);
      console.log('  Settings:', JSON.stringify(p.settings, null, 2));
    }

    // Check scheduled cron for Microsoft polling in code vs what's actually happening
    const polls = await pool.query(`
      SELECT run_type, COUNT(*) as count, MAX(started_at) as last_run
      FROM poll_runs
      WHERE pharmacy_id = (SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%aracoma%')
      GROUP BY run_type
      ORDER BY last_run DESC
    `);

    console.log('\nAracoma poll types:');
    polls.rows.forEach(r => {
      console.log(`  ${r.run_type}: ${r.count} runs, last: ${r.last_run}`);
    });

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
