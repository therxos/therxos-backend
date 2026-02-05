require('dotenv').config();

// Need to use dynamic import for ES modules
async function run() {
  const { pollForOutcomesReports } = await import('./src/services/microsoftPoller.js');

  try {
    console.log('Testing Microsoft Outcomes poll for Aracoma...');
    const result = await pollForOutcomesReports({
      pharmacyId: '5b77e7f0-66c0-4f1b-b307-deeed69354c9',
      daysBack: 7
    });
    console.log('Result:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }

  process.exit(0);
}

run();
