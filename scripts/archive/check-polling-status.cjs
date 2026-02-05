const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  try {
    // Check which pharmacies have polling enabled
    const pharmacies = await pool.query(`
      SELECT pharmacy_id, pharmacy_name,
             settings->>'gmail_polling_enabled' as gmail_enabled,
             settings->>'microsoft_polling_enabled' as microsoft_enabled
      FROM pharmacies
      WHERE settings->>'gmail_polling_enabled' = 'true'
         OR settings->>'microsoft_polling_enabled' = 'true'
    `);

    console.log('Pharmacies with polling enabled:');
    pharmacies.rows.forEach(p => {
      console.log(`  ${p.pharmacy_name}: Gmail=${p.gmail_enabled}, Microsoft=${p.microsoft_enabled}`);
    });

    // Check recent poll_runs
    const runs = await pool.query(`
      SELECT pr.run_type, pr.started_at::date as run_date, p.pharmacy_name,
             pr.summary::text
      FROM poll_runs pr
      LEFT JOIN pharmacies p ON p.pharmacy_id = pr.pharmacy_id
      WHERE pr.started_at >= NOW() - INTERVAL '3 days'
      ORDER BY pr.started_at DESC
      LIMIT 20
    `);

    console.log('\nRecent poll runs (last 3 days):');
    runs.rows.forEach(r => {
      const summary = JSON.parse(r.summary || '{}');
      console.log(`  ${r.run_date.toISOString().slice(0,10)} ${r.run_type.padEnd(15)} ${(r.pharmacy_name || 'N/A').padEnd(20)} emails=${summary.emailsProcessed || 0}`);
    });

    // Check Microsoft token status
    const tokenResult = await pool.query(`
      SELECT setting_key, updated_at,
             token_data->>'expiresOn' as expires_on,
             token_data->'account'->>'username' as account
      FROM system_settings
      WHERE setting_key IN ('microsoft_oauth_tokens', 'gmail_oauth_tokens')
    `);

    console.log('\nOAuth tokens:');
    tokenResult.rows.forEach(t => {
      console.log(`  ${t.setting_key}: expires=${t.expires_on}, account=${t.account}`);
    });

    // Check Aracoma's processed_emails source breakdown
    const aracomaEmails = await pool.query(`
      SELECT source, COUNT(*) as count, MAX(processed_at) as latest
      FROM processed_emails
      WHERE pharmacy_id = '5b77e7f0-66c0-4f1b-b307-deeed69354c9'
      GROUP BY source
    `);

    console.log('\nAracoma processed_emails by source:');
    aracomaEmails.rows.forEach(e => {
      console.log(`  ${e.source}: ${e.count} emails, latest: ${e.latest}`);
    });

    await pool.end();
  } catch (e) {
    console.error('Error:', e.message);
    await pool.end();
  }
})();
