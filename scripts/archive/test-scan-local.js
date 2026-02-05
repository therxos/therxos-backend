import 'dotenv/config';
import { scanAllTriggerCoverage } from './src/services/coverage-scanner.js';

try {
  console.log('Starting bulk coverage scan...');
  const result = await scanAllTriggerCoverage({ minClaims: 1, daysBack: 365, minMargin: 10, dmeMinMargin: 3 });
  console.log('\n=== SCAN COMPLETE ===');
  console.log('Triggers with matches:', result.results?.length);
  console.log('Triggers with no matches:', result.noMatches?.length);
  if (result.noMatches) {
    result.noMatches.forEach(n => console.log('  NO MATCH:', n.triggerName, '-', n.reason));
  }
  if (result.results) {
    result.results.forEach(r => console.log('  MATCH:', r.triggerName, '- bins:', r.verifiedCount));
  }
  process.exit(0);
} catch (e) {
  console.error('SCAN FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
}
