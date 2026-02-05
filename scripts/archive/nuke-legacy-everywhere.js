import 'dotenv/config';
import db from './src/database/index.js';

const LEGACY_DRUGS = [
  'Omega-3 Fatty Acids', 'Low-dose Aspirin', 'Home BP Monitor', 'Adherence Check',
  'Glucose Test Strips', 'Spacer Device', 'Statin Therapy', 'Glucagon',
  'Glucagon Emergency Kit', 'Calcium + Vitamin D', 'Rescue Inhaler (SABA)',
  'Naloxone (Narcan)', 'Lidocaine 5% ointment', 'Pen Needles'
];

// 1. Count legacy opps across ALL pharmacies
const legacyOpps = await db.query(`
  SELECT recommended_drug_name, status, COUNT(*) as count
  FROM opportunities
  WHERE recommended_drug_name = ANY($1)
  GROUP BY recommended_drug_name, status
  ORDER BY recommended_drug_name, status
`, [LEGACY_DRUGS]);
console.log('=== Legacy opportunities across ALL pharmacies ===');
for (const r of legacyOpps.rows) {
  console.log(r.recommended_drug_name, '|', r.status, '|', r.count);
}

// 2. Count data quality issues for legacy opps
const legacyDQI = await db.query(`
  SELECT dqi.issue_type, dqi.status, COUNT(*) as count
  FROM data_quality_issues dqi
  JOIN opportunities o ON o.opportunity_id = dqi.opportunity_id
  WHERE o.recommended_drug_name = ANY($1)
  GROUP BY dqi.issue_type, dqi.status
  ORDER BY count DESC
`, [LEGACY_DRUGS]);
console.log('\n=== Data quality issues for legacy opps ===');
for (const r of legacyDQI.rows) {
  console.log(r.issue_type, '|', r.status, '|', r.count);
}

// 3. Delete data quality issues for legacy Not Submitted opps
const deletedDQI = await db.query(`
  DELETE FROM data_quality_issues
  WHERE opportunity_id IN (
    SELECT opportunity_id FROM opportunities
    WHERE recommended_drug_name = ANY($1)
      AND status = 'Not Submitted'
  )
  RETURNING issue_id
`, [LEGACY_DRUGS]);
console.log('\nDeleted', deletedDQI.rows.length, 'data quality issues for legacy opps');

// 4. Delete legacy Not Submitted opps across ALL pharmacies
const deletedOpps = await db.query(`
  DELETE FROM opportunities
  WHERE recommended_drug_name = ANY($1)
    AND status = 'Not Submitted'
  RETURNING opportunity_id, pharmacy_id
`, [LEGACY_DRUGS]);
console.log('Deleted', deletedOpps.rows.length, 'legacy opportunities');

// Count by pharmacy
const byPharmacy = {};
for (const r of deletedOpps.rows) {
  byPharmacy[r.pharmacy_id] = (byPharmacy[r.pharmacy_id] || 0) + 1;
}
for (const [pid, count] of Object.entries(byPharmacy)) {
  console.log('  pharmacy', pid, ':', count);
}

// 5. Also delete any trigger_id=NULL Not Submitted opps across ALL pharmacies (any remaining junk from old scanner)
const deletedNoTrigger = await db.query(`
  DELETE FROM opportunities
  WHERE trigger_id IS NULL
    AND status = 'Not Submitted'
  RETURNING opportunity_id, pharmacy_id
`, []);
console.log('\nDeleted', deletedNoTrigger.rows.length, 'additional no-trigger opps');
const byPharmacy2 = {};
for (const r of deletedNoTrigger.rows) {
  byPharmacy2[r.pharmacy_id] = (byPharmacy2[r.pharmacy_id] || 0) + 1;
}
for (const [pid, count] of Object.entries(byPharmacy2)) {
  console.log('  pharmacy', pid, ':', count);
}

// 6. Clean up orphaned data quality issues (opportunity was deleted but DQI remains)
const orphanedDQI = await db.query(`
  DELETE FROM data_quality_issues
  WHERE opportunity_id IS NOT NULL
    AND opportunity_id NOT IN (SELECT opportunity_id FROM opportunities)
  RETURNING issue_id
`);
console.log('\nDeleted', orphanedDQI.rows.length, 'orphaned data quality issues');

// 7. Delete pending_opportunity_types for legacy drugs
const deletedPOT = await db.query(`
  DELETE FROM pending_opportunity_types
  WHERE recommended_drug_name = ANY($1)
  RETURNING pending_type_id, recommended_drug_name
`, [LEGACY_DRUGS]);
console.log('\nDeleted', deletedPOT.rows.length, 'legacy pending_opportunity_types');
for (const r of deletedPOT.rows) {
  console.log('  ', r.recommended_drug_name);
}

// 8. Verify nothing legacy remains
const remaining = await db.query(`
  SELECT recommended_drug_name, COUNT(*) as count
  FROM opportunities
  WHERE recommended_drug_name = ANY($1)
  GROUP BY recommended_drug_name
`, [LEGACY_DRUGS]);
if (remaining.rows.length > 0) {
  console.log('\n=== Remaining (actioned, preserved) ===');
  for (const r of remaining.rows) {
    console.log(r.recommended_drug_name, ':', r.count);
  }
} else {
  console.log('\nNo legacy opportunities remain anywhere. Clean.');
}

const remainingDQI = await db.query(`
  SELECT COUNT(*) as count FROM data_quality_issues
  WHERE opportunity_id NOT IN (SELECT opportunity_id FROM opportunities)
`);
console.log('Orphaned DQIs remaining:', remainingDQI.rows[0].count);

process.exit(0);
