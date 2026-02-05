import 'dotenv/config';
import db from './src/database/index.js';

// 1. Count auto-generated staff notes
const counts = await db.query(`
  SELECT
    CASE
      WHEN staff_notes LIKE 'Scanned for trigger%' THEN 'Scanned for trigger'
      WHEN staff_notes LIKE 'Auto-detected by rescan%' THEN 'Auto-detected by rescan'
      ELSE 'other'
    END as note_type,
    COUNT(*) as count
  FROM opportunities
  WHERE staff_notes IS NOT NULL AND staff_notes != ''
  GROUP BY 1
  ORDER BY 2 DESC
`);
console.log('=== Staff Notes breakdown ===');
for (const r of counts.rows) {
  console.log(r.note_type, ':', r.count);
}

// 2. Clear all auto-generated staff notes
const cleared = await db.query(`
  UPDATE opportunities
  SET staff_notes = NULL
  WHERE staff_notes LIKE 'Scanned for trigger%'
     OR staff_notes LIKE 'Auto-detected by rescan%'
  RETURNING opportunity_id
`);
console.log('\nCleared', cleared.rows.length, 'auto-generated staff notes');

// 3. Check GNP Pen opps on wrong BINs
const gnpWrong = await db.query(`
  SELECT o.opportunity_id, o.recommended_drug_name, pr.insurance_bin, o.status, o.pharmacy_id
  FROM opportunities o
  LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
  WHERE o.recommended_drug_name ILIKE '%GNP%Pen%'
    AND o.status = 'Not Submitted'
    AND (pr.insurance_bin IS NULL OR pr.insurance_bin NOT IN ('004336', '610502'))
`);
console.log('\n=== GNP Pen opps on wrong BINs ===');
console.log('Count:', gnpWrong.rows.length);
for (const r of gnpWrong.rows.slice(0, 10)) {
  console.log('  BIN:', r.insurance_bin, '| pharmacy:', r.pharmacy_id);
}

// 4. Delete GNP Pen opps on wrong BINs (only Not Submitted)
if (gnpWrong.rows.length > 0) {
  const ids = gnpWrong.rows.map(r => r.opportunity_id);
  const deleted = await db.query(`
    DELETE FROM opportunities
    WHERE opportunity_id = ANY($1)
      AND status = 'Not Submitted'
    RETURNING opportunity_id
  `, [ids]);
  console.log('Deleted', deleted.rows.length, 'GNP opps on wrong BINs');
}

process.exit(0);
