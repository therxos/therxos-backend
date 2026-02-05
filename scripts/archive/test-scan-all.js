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

  // Get triggers
  const trigRes = await fetch(`${API}/api/admin/triggers`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const triggers = (await trigRes.json()).triggers;

  // Find a simple trigger to test with
  const testTrigger = triggers?.find(t => t.display_name?.includes('Aripiprazole') && t.display_name?.includes('ODT'));
  if (!testTrigger) { console.error('No test trigger found'); return; }

  console.log(`Testing scan for: ${testTrigger.display_name} (${testTrigger.trigger_id})`);

  const scanRes = await fetch(`${API}/api/admin/triggers/${testTrigger.trigger_id}/scan`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  console.log(`Status: ${scanRes.status}`);
  const text = await scanRes.text();
  try {
    const data = JSON.parse(text);
    console.log('Response:', JSON.stringify(data, null, 2).substring(0, 2000));
  } catch {
    console.log('Raw:', text.substring(0, 2000));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
