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
  console.log('Testing PRODUCTION coverage scan...');
  const token = await login(PROD_URL);

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

  console.log(`Triggers scanned: ${data.summary?.totalTriggers || 'unknown'}`);
  console.log(`With matches: ${data.summary?.withMatches || (data.results || []).length}`);
  console.log(`No matches: ${data.summary?.noMatches || (data.noMatches || []).length}`);

  console.log('\n--- NO MATCHES ---');
  (data.noMatches || []).forEach(nm => {
    console.log(`  ✗ ${nm.triggerName}: ${nm.reason}`);
  });

  console.log(`\n--- WITH MATCHES: ${(data.results || []).length} ---`);
  (data.results || []).forEach(r => {
    console.log(`  ✓ ${r.triggerName}: ${r.binCount} BINs, GP: $${parseFloat(r.defaultGp || 0).toFixed(2)}`);
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
