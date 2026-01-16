import 'dotenv/config';

async function test() {
  // Try Heights Chemist user
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

  const prescriberRes = await fetch('https://therxos-backend-production.up.railway.app/api/analytics/prescriber-stats?limit=10', {
    headers: { 'Authorization': 'Bearer ' + loginData.token }
  });
  const prescriberData = await prescriberRes.json();

  console.log('\nPRESCRIBER STATS:');
  console.log('Summary:', JSON.stringify(prescriberData.summary, null, 2));
  console.log('\nTop 5 by Value:');
  if (prescriberData.top_by_value) {
    prescriberData.top_by_value.slice(0, 5).forEach(p => {
      console.log('  ' + (p.prescriber_name || 'Unknown').substring(0,30).padEnd(32) + ' | $' + p.annual_potential?.toLocaleString() + ' annual | ' + p.opportunity_count + ' opps');
    });
  }

  const drugRes = await fetch('https://therxos-backend-production.up.railway.app/api/analytics/recommended-drug-stats?limit=10', {
    headers: { 'Authorization': 'Bearer ' + loginData.token }
  });
  const drugData = await drugRes.json();
  console.log('\nRECOMMENDED DRUG STATS - Top 5:');
  if (drugData.top_recommended_drugs) {
    drugData.top_recommended_drugs.slice(0, 5).forEach(d => {
      console.log('  ' + (d.recommended_drug || 'Unknown').substring(0,30).padEnd(32) + ' | $' + d.annual_potential?.toLocaleString() + ' annual | ' + d.opportunity_count + ' opps');
    });
  }
}

test().catch(console.error);
