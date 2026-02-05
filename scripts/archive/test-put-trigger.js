import 'dotenv/config';

const API = 'https://therxos-backend-production.up.railway.app';

async function main() {
  // Login first
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok) { console.error('Login failed:', loginData); return; }
  const token = loginData.token;
  console.log('Logged in OK');

  const triggerId = '5e0ed397-04ab-4bd8-adb7-47caaa71db37';

  // Test 1: Minimal PUT - just displayName (no arrays, no GP, no backfill)
  console.log('\n=== Test 1: Minimal payload (name only) ===');
  let res = await fetch(`${API}/api/admin/triggers/${triggerId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Aripiprazole to ODT' }),
  });
  console.log(`Status: ${res.status}`, await res.json());

  // Test 2: Add array fields (bin_inclusions etc)
  console.log('\n=== Test 2: With array fields ===');
  res = await fetch(`${API}/api/admin/triggers/${triggerId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Aripiprazole to ODT',
      binInclusions: [],
      binExclusions: [],
      groupInclusions: [],
      groupExclusions: [],
      keywordMatchMode: 'any',
    }),
  });
  console.log(`Status: ${res.status}`, await res.json());

  // Test 3: With annualFills/defaultGpValue (triggers backfill)
  console.log('\n=== Test 3: With GP/fills (triggers backfill) ===');
  res = await fetch(`${API}/api/admin/triggers/${triggerId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Aripiprazole to ODT',
      annualFills: 12,
      defaultGpValue: 82,
    }),
  });
  console.log(`Status: ${res.status}`, await res.json());

  // Test 4: Full payload like frontend sends
  console.log('\n=== Test 4: Full payload ===');
  res = await fetch(`${API}/api/admin/triggers/${triggerId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Aripiprazole to ODT',
      triggerCode: 'ARIPIPRAZOLE_ODT',
      triggerType: 'formulation_change',
      category: 'Formulation Change',
      detectionKeywords: ['Aripiprazole', 'Abilify'],
      excludeKeywords: ['ODT'],
      ifHasKeywords: [],
      ifNotHasKeywords: [],
      recommendedDrug: 'Aripiprazole Odt',
      recommendedNdc: null,
      clinicalRationale: null,
      actionInstructions: 'Send Rx Change Request with Clinical Justification in Notes',
      priority: 'medium',
      annualFills: 12,
      defaultGpValue: 82,
      keywordMatchMode: 'any',
      isEnabled: true,
      binInclusions: [],
      binExclusions: [],
      groupInclusions: [],
      groupExclusions: [],
      contractPrefixExclusions: [],
    }),
  });
  console.log(`Status: ${res.status}`, await res.json());
}

main().catch(e => { console.error(e); process.exit(1); });
