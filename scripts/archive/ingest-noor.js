import fs from 'fs';
import db from './src/database/index.js';
import { ingestSync } from './src/services/ingest-fast-service.js';

async function main() {
  // Find Noor Pharmacy
  const result = await db.query(
    "SELECT pharmacy_id, pharmacy_name FROM pharmacies WHERE pharmacy_name ILIKE '%noor%'"
  );

  if (result.rows.length === 0) {
    console.log('Noor Pharmacy not found. Existing pharmacies:');
    const all = await db.query('SELECT pharmacy_id, pharmacy_name FROM pharmacies');
    all.rows.forEach(r => console.log(`  ${r.pharmacy_name} (${r.pharmacy_id})`));
    process.exit(1);
  }

  const pharmacy = result.rows[0];
  console.log(`Found: ${pharmacy.pharmacy_name} (${pharmacy.pharmacy_id})`);

  // Read CSV
  const csv = fs.readFileSync('Noor.csv', 'utf-8');
  const lineCount = csv.split('\n').filter(l => l.trim()).length - 1;
  console.log(`CSV has ${lineCount} data rows`);

  // Ingest
  console.log('Starting ingestion...');
  const ingestionResult = await ingestSync(pharmacy.pharmacy_id, csv);
  console.log('Done!', ingestionResult);

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
