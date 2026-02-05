import 'dotenv/config';
import db from './src/database/index.js';

async function main() {
  const r = await db.query(`
    SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
    FROM prescriptions
    WHERE (POSITION('AMLODIPINE' IN UPPER(drug_name)) > 0 AND POSITION('ATORVASTATIN' IN UPPER(drug_name)) > 0)
       OR POSITION('CADUET' IN UPPER(drug_name)) > 0
    GROUP BY UPPER(drug_name)
    ORDER BY cnt DESC LIMIT 20
  `);
  console.log('Amlodipine-Atorvastatin or Caduet drugs in data:');
  r.rows.forEach(d => console.log('  ' + d.dn + ' | claims: ' + d.cnt));
  if (r.rows.length === 0) console.log('  NONE FOUND');

  // Broader search
  const r2 = await db.query(`
    SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
    FROM prescriptions
    WHERE POSITION('AMLODIP' IN UPPER(drug_name)) > 0 AND POSITION('ATORV' IN UPPER(drug_name)) > 0
    GROUP BY UPPER(drug_name)
    ORDER BY cnt DESC LIMIT 10
  `);
  console.log('\nBroader search (AMLODIP + ATORV):');
  r2.rows.forEach(d => console.log('  ' + d.dn + ' | claims: ' + d.cnt));
  if (r2.rows.length === 0) console.log('  NONE FOUND');

  // Check if the Sucralfate fix works now (exclude_keywords has "SUSP" and "SUSPENSION" which would exclude the recommended drug "Sucralfate" — wait, "SUSP" is not in "SUCRALFATE")
  // Actually check the Sucralfate situation — recommended_drug is now "Sucralfate" but exclude_keywords are ["SUSP","SUSPENSION"]
  // SUSP is NOT in SUCRALFATE, and SUSPENSION is NOT in SUCRALFATE, so this should be fine
  // The exclude works on drug_name matches, not recommended_drug

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
