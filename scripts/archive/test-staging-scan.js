import 'dotenv/config';

const STAGING_URL = 'https://discerning-mindfulness-production-07d5.up.railway.app';

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  const data = await res.json();
  if (!data.token) {
    console.log('Login failed:', JSON.stringify(data));
    process.exit(1);
  }
  return data.token;
}

async function main() {
  console.log('Testing staging coverage scan...');
  const token = await login(STAGING_URL);
  console.log('Logged in to staging.\n');

  const res = await fetch(`${STAGING_URL}/api/admin/triggers/verify-all-coverage`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });

  const data = await res.json();

  if (data.error) {
    console.log('ERROR:', data.error);
    process.exit(1);
  }

  const summary = data.summary || {};
  console.log(`Triggers scanned: ${summary.totalTriggers || 'unknown'}`);
  console.log(`With matches: ${summary.withMatches || (data.results || []).length}`);
  console.log(`No matches: ${summary.noMatches || (data.noMatches || []).length}`);

  console.log('\n--- NO MATCHES ---');
  (data.noMatches || []).forEach(nm => {
    console.log(`  ✗ ${nm.triggerName}: ${nm.reason}`);
  });

  console.log('\n--- WITH MATCHES (top drug per trigger) ---');
  (data.results || []).forEach(r => {
    const topBin = r.bins && r.bins.length > 0 ? r.bins[0] : null;
    const bestDrug = topBin ? (topBin.best_drug_name || topBin.best_drug || '') : '';
    console.log(`  ✓ ${r.triggerName}: ${r.binCount || (r.bins || []).length} BINs, GP: $${parseFloat(r.defaultGp || 0).toFixed(2)}${bestDrug ? `, best: ${bestDrug}` : ''}`);
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
