import 'dotenv/config';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  return (await res.json()).token;
}

async function main() {
  const token = await login(PROD_URL);

  console.log('Running coverage scan via API...\n');
  const res = await fetch(`${PROD_URL}/api/admin/triggers/verify-all-coverage`, {
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
  console.log('Summary:', JSON.stringify(summary, null, 2));

  console.log('\n--- NO MATCHES ---');
  const noMatches = data.noMatches || [];
  noMatches.forEach(nm => {
    console.log(`  ✗ ${nm.triggerName}: ${nm.reason}`);
  });

  console.log('\n--- WITH MATCHES ---');
  const results = data.results || [];
  results.forEach(r => {
    console.log(`  ✓ ${r.triggerName}: ${r.binCount} BINs, GP: $${r.defaultGp || 'N/A'}`);
  });

  console.log(`\nTotal: ${results.length} with matches, ${noMatches.length} without`);

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
