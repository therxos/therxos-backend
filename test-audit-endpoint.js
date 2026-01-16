import 'dotenv/config';

async function test() {
  // Login as Heights Chemist user
  const loginRes = await fetch('https://therxos-backend-production.up.railway.app/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'heightschemistrx@yahoo.com', password: 'demo1234' })
  });
  const loginData = await loginRes.json();
  if (!loginData.token) {
    console.log('Login failed:', loginData);
    return;
  }
  console.log('Logged in as:', loginData.user?.email);
  console.log('Pharmacy ID:', loginData.user?.pharmacyId);

  // Test audit-flags endpoint
  const auditRes = await fetch('https://therxos-backend-production.up.railway.app/api/analytics/audit-flags?status=open&limit=100', {
    headers: { 'Authorization': 'Bearer ' + loginData.token }
  });
  console.log('\nAudit endpoint status:', auditRes.status);
  const auditData = await auditRes.json();
  console.log('Response keys:', Object.keys(auditData));
  console.log('Flags count:', auditData.flags?.length || 0);

  if (auditData.error) {
    console.log('Error:', auditData.error);
  }

  if (auditData.flags?.length > 0) {
    console.log('\nFirst 3 flags:');
    auditData.flags.slice(0, 3).forEach((f, i) => {
      console.log(`  ${i+1}. ${f.rule_name} - ${f.patient_name || 'Unknown'} - ${f.drug_name}`);
    });
  }
}

test().catch(console.error);
