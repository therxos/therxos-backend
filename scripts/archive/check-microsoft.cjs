require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  // Check Aracoma's settings
  const aracoma = await pool.query("SELECT settings, pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%aracoma%'");
  console.log('Aracoma settings:', JSON.stringify(aracoma.rows[0]?.settings, null, 2));
  console.log('Aracoma pharmacy_id:', aracoma.rows[0]?.pharmacy_id);

  // Check for Microsoft tokens
  const msTokens = await pool.query("SELECT setting_key, updated_at FROM system_settings WHERE setting_key ILIKE '%microsoft%' OR setting_key ILIKE '%outlook%'");
  console.log('\nMicrosoft/Outlook tokens:');
  if (msTokens.rows.length === 0) console.log('  NONE FOUND');
  msTokens.rows.forEach(r => console.log('  ' + r.setting_key + ' | updated: ' + r.updated_at));

  // Check poll runs for Microsoft
  const runs = await pool.query(`
    SELECT run_type, pharmacy_id, started_at, summary
    FROM poll_runs
    WHERE run_type ILIKE '%microsoft%' OR run_type ILIKE '%outlook%'
    ORDER BY started_at DESC
    LIMIT 5
  `);
  console.log('\nRecent Microsoft poll runs:');
  if (runs.rows.length === 0) console.log('  NONE');
  runs.rows.forEach(r => {
    const s = r.summary || {};
    console.log('  ' + r.started_at + ' | ' + r.run_type + ' | records: ' + (s.totalRecordsIngested || 0));
  });

  // Check cron jobs
  console.log('\nEnvironment variables for Microsoft:');
  console.log('  MICROSOFT_CLIENT_ID: ' + (process.env.MICROSOFT_CLIENT_ID ? 'SET' : 'NOT SET'));
  console.log('  MICROSOFT_CLIENT_SECRET: ' + (process.env.MICROSOFT_CLIENT_SECRET ? 'SET' : 'NOT SET'));

  await pool.end();
}
check().catch(e => console.error(e));
