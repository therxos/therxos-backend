import 'dotenv/config';
import db from './src/database/index.js';

const PARKWAY = 'f0bd945a-836d-422b-8e58-ceb4dda0a12a';

// Count before
const before = await db.query(`
  SELECT COUNT(*) as total,
    COUNT(CASE WHEN trigger_id IS NULL THEN 1 END) as no_trigger,
    COUNT(CASE WHEN trigger_id IS NOT NULL THEN 1 END) as has_trigger
  FROM opportunities
  WHERE pharmacy_id = $1 AND status = 'Not Submitted'
`, [PARKWAY]);
console.log('BEFORE:', before.rows[0]);

// Show what we're deleting
const junkTypes = await db.query(`
  SELECT recommended_drug_name, COUNT(*) as count
  FROM opportunities
  WHERE pharmacy_id = $1 AND trigger_id IS NULL AND status = 'Not Submitted'
  GROUP BY recommended_drug_name
  ORDER BY count DESC
  LIMIT 20
`, [PARKWAY]);
console.log('\nJunk opps to delete:');
for (const r of junkTypes.rows) {
  console.log(' ', r.recommended_drug_name, ':', r.count);
}

// DELETE all junk (no trigger_id, Not Submitted only)
const deleted = await db.query(`
  DELETE FROM opportunities
  WHERE pharmacy_id = $1
    AND trigger_id IS NULL
    AND status = 'Not Submitted'
  RETURNING opportunity_id
`, [PARKWAY]);
console.log('\nDELETED:', deleted.rows.length, 'junk opportunities');

// Count after
const after = await db.query(`
  SELECT COUNT(*) as total,
    COUNT(CASE WHEN trigger_id IS NULL THEN 1 END) as no_trigger,
    COUNT(CASE WHEN trigger_id IS NOT NULL THEN 1 END) as has_trigger
  FROM opportunities
  WHERE pharmacy_id = $1 AND status = 'Not Submitted'
`, [PARKWAY]);
console.log('\nAFTER:', after.rows[0]);

// Verify no legacy drugs remain
const check = await db.query(`
  SELECT recommended_drug_name, COUNT(*) as count
  FROM opportunities
  WHERE pharmacy_id = $1
    AND recommended_drug_name IN ('Omega-3 Fatty Acids', 'Low-dose Aspirin', 'Home BP Monitor', 'Adherence Check', 'Spacer Device', 'Glucose Test Strips', 'Statin Therapy', 'Glucagon', 'Glucagon Emergency Kit', 'Calcium + Vitamin D', 'Rescue Inhaler (SABA)', 'Naloxone (Narcan)', 'Lidocaine 5% ointment')
    AND status = 'Not Submitted'
  GROUP BY recommended_drug_name
`, [PARKWAY]);
if (check.rows.length === 0) {
  console.log('\nNo legacy junk remains. Clean.');
} else {
  console.log('\nWARNING - legacy drugs still present:');
  for (const r of check.rows) {
    console.log(' ', r.recommended_drug_name, ':', r.count);
  }
}

process.exit(0);
