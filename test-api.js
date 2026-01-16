// Test the live API to see what it returns
const token = process.argv[2];

if (!token) {
  console.log('Usage: node test-api.js <auth_token>');
  console.log('Get token from browser DevTools -> Application -> Local Storage -> therxos_token');
  process.exit(1);
}

async function test() {
  const res = await fetch('https://therxos-backend-production.up.railway.app/api/opportunities', {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  const data = await res.json();

  console.log('=== API RESPONSE ===\n');
  console.log('Counts from API:', data.counts);
  console.log('\nPagination:', data.pagination);
  console.log('\nOpportunities returned:', data.opportunities?.length);

  // Calculate our own counts from the returned data
  if (data.opportunities) {
    const statusCounts = {};
    data.opportunities.forEach(o => {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    });
    console.log('\nCalculated from returned opportunities:', statusCounts);
  }
}

test().catch(console.error);
