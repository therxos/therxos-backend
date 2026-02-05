import 'dotenv/config';

const API = 'https://therxos-backend-production.up.railway.app';

async function main() {
  // Login
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  const loginData = await loginRes.json();
  const token = loginData.token;
  console.log('Logged in OK');

  const triggerId = '5e0ed397-04ab-4bd8-adb7-47caaa71db37';

  // Run coverage scan
  console.log('\n=== Running scan-coverage on production ===');
  const scanRes = await fetch(`${API}/api/admin/triggers/${triggerId}/scan-coverage`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ minMargin: 10, daysBack: 365 }),
  });

  console.log(`Status: ${scanRes.status}`);
  const data = await scanRes.json();
  console.log('Full response:', JSON.stringify(data, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
