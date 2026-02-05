import 'dotenv/config';
import { scanAllTriggerCoverage } from './src/services/coverage-scanner.js';

async function main() {
  console.log('Running coverage scan locally...\n');
  const result = await scanAllTriggerCoverage({ minClaims: 1, daysBack: 365, minMargin: 10, dmeMinMargin: 3 });

  console.log(`\nTriggers scanned: ${result.summary.totalTriggers}`);
  console.log(`With matches: ${result.summary.triggersWithMatches}`);
  console.log(`No matches: ${result.summary.triggersWithNoMatches}`);

  console.log('\n--- NO MATCHES ---');
  result.noMatches.forEach(nm => {
    console.log(`  ✗ ${nm.triggerName}: ${nm.reason}`);
  });

  console.log('\n--- WITH MATCHES ---');
  result.results.forEach(r => {
    const top = r.topBins && r.topBins[0];
    console.log(`  ✓ ${r.triggerName}: ${r.verifiedCount} BINs, top: ${top ? `${top.bestDrug} GP:$${top.avgMargin}` : 'N/A'}`);
  });

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
