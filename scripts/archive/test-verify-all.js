import 'dotenv/config';

const API = 'https://therxos-backend-production.up.railway.app';

async function main() {
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  const loginData = await loginRes.json();
  const token = loginData.token;
  console.log('Logged in OK');

  console.log('\n=== Testing verify-all-coverage ===');
  const res = await fetch(`${API}/api/admin/triggers/verify-all-coverage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  console.log(`Status: ${res.status}`);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data.error) {
      console.log('Error:', data.error);
    } else {
      console.log('Summary:', JSON.stringify(data.summary, null, 2));
      // Show first few results
      if (data.results) {
        for (const r of data.results.slice(0, 5)) {
          console.log(`  ${r.triggerName}: ${r.verifiedCount || 0} matches`);
        }
        if (data.results.length > 5) console.log(`  ... and ${data.results.length - 5} more`);
      }
    }
  } catch {
    console.log('Raw:', text.substring(0, 1000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
