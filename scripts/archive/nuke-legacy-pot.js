import 'dotenv/config';
import db from './src/database/index.js';

const LEGACY_DRUGS = [
  'Omega-3 Fatty Acids', 'Low-dose Aspirin', 'Home BP Monitor', 'Adherence Check',
  'Glucose Test Strips', 'Spacer Device', 'Statin Therapy', 'Glucagon',
  'Glucagon Emergency Kit', 'Calcium + Vitamin D', 'Rescue Inhaler (SABA)',
  'Naloxone (Narcan)', 'Lidocaine 5% ointment', 'Pen Needles'
];

// Delete approval log entries for legacy pending types first
const deletedLog = await db.query(`
  DELETE FROM opportunity_approval_log
  WHERE pending_type_id IN (
    SELECT pending_type_id FROM pending_opportunity_types
    WHERE recommended_drug_name = ANY($1)
  )
  RETURNING log_id
`, [LEGACY_DRUGS]);
console.log('Deleted', deletedLog.rows.length, 'approval log entries');

// Now delete the pending types
const deletedPOT = await db.query(`
  DELETE FROM pending_opportunity_types
  WHERE recommended_drug_name = ANY($1)
  RETURNING pending_type_id, recommended_drug_name
`, [LEGACY_DRUGS]);
console.log('Deleted', deletedPOT.rows.length, 'legacy pending_opportunity_types:');
for (const r of deletedPOT.rows) {
  console.log('  ', r.recommended_drug_name);
}

// Final verification
const remainingOpps = await db.query(`
  SELECT recommended_drug_name, COUNT(*) as count
  FROM opportunities WHERE recommended_drug_name = ANY($1)
  GROUP BY recommended_drug_name
`, [LEGACY_DRUGS]);
if (remainingOpps.rows.length > 0) {
  console.log('\nActioned legacy opps preserved (will not delete):');
  for (const r of remainingOpps.rows) {
    console.log('  ', r.recommended_drug_name, ':', r.count);
  }
} else {
  console.log('\nNo legacy opportunities remain.');
}

const remainingDQI = await db.query(`
  SELECT COUNT(*) as count FROM data_quality_issues
  WHERE opportunity_id IN (SELECT opportunity_id FROM opportunities WHERE recommended_drug_name = ANY($1))
`, [LEGACY_DRUGS]);
console.log('Legacy DQIs remaining:', remainingDQI.rows[0].count);

const remainingPOT = await db.query(`
  SELECT COUNT(*) as count FROM pending_opportunity_types
  WHERE recommended_drug_name = ANY($1)
`, [LEGACY_DRUGS]);
console.log('Legacy pending types remaining:', remainingPOT.rows[0].count);

process.exit(0);
