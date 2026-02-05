require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check OAuth tokens
  const tokens = await pool.query("SELECT setting_key, token_data, updated_at FROM system_settings WHERE setting_key = 'gmail_oauth_tokens'");
  if (tokens.rows.length > 0) {
    const t = tokens.rows[0].token_data;
    console.log('Gmail OAuth tokens:');
    console.log('  Updated: ' + tokens.rows[0].updated_at);
    console.log('  Expiry: ' + (t.expiry_date ? new Date(t.expiry_date).toISOString() : 'N/A'));
    console.log('  Has refresh_token: ' + (t.refresh_token ? 'YES' : 'NO'));
    console.log('  Has access_token: ' + (t.access_token ? 'YES (starts: ' + t.access_token.slice(0,20) + '...)' : 'NO'));
  } else {
    console.log('NO GMAIL OAUTH TOKENS CONFIGURED');
  }

  // Check pharmacy SPP settings for Bravo and Aracoma
  const pharmacies = await pool.query(`
    SELECT p.pharmacy_name, p.settings, p.pharmacy_id
    FROM pharmacies p
    JOIN clients c ON c.client_id = p.client_id
    WHERE p.pharmacy_name ILIKE '%bravo%' OR p.pharmacy_name ILIKE '%aracoma%'
  `);

  console.log('\nPharmacy SPP settings:');
  for (const p of pharmacies.rows) {
    console.log('  ' + p.pharmacy_name + ':');
    console.log('    spp_report_name: ' + (p.settings?.spp_report_name || 'NOT SET'));
    console.log('    pharmacy_id: ' + p.pharmacy_id);
  }

  // Check recent poll runs
  const runs = await pool.query(`
    SELECT run_id, pharmacy_id, started_at, summary
    FROM poll_runs
    WHERE run_type = 'spp_poll'
    ORDER BY started_at DESC
    LIMIT 5
  `);

  console.log('\nRecent SPP poll runs:');
  if (runs.rows.length === 0) {
    console.log('  NO POLL RUNS FOUND');
  }
  for (const r of runs.rows) {
    const s = r.summary || {};
    console.log('  ' + r.started_at + ' | emails: ' + (s.emailsProcessed || 0) + ' | records: ' + (s.totalRecordsIngested || 0) + ' | errors: ' + JSON.stringify(s.errors || []));
  }

  // Check env vars
  console.log('\nEnvironment variables:');
  console.log('  GMAIL_CLIENT_ID: ' + (process.env.GMAIL_CLIENT_ID ? 'SET (' + process.env.GMAIL_CLIENT_ID.slice(0,20) + '...)' : 'NOT SET'));
  console.log('  GMAIL_CLIENT_SECRET: ' + (process.env.GMAIL_CLIENT_SECRET ? 'SET' : 'NOT SET'));

  await pool.end();
}
check().catch(e => console.error(e));
