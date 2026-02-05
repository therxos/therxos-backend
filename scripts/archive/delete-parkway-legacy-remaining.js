import 'dotenv/config';
import db from './src/database/index.js';

const PARKWAY = 'f0bd945a-836d-422b-8e58-ceb4dda0a12a';
const GOOD_BATCH = 'scan_1769795277218_c801be33'; // The proper trigger-based scan

// Check what scan batches exist for Parkway
const batches = await db.query(`
  SELECT scan_batch_id, COUNT(*) as count,
    MIN(potential_margin_gain) as min_gp, MAX(potential_margin_gain) as max_gp,
    MIN(created_at) as earliest
  FROM opportunities
  WHERE pharmacy_id = $1 AND status = 'Not Submitted'
  GROUP BY scan_batch_id
  ORDER BY count DESC
`, [PARKWAY]);
console.log('=== Scan batches for Parkway ===');
for (const r of batches.rows) {
  console.log('batch:', r.scan_batch_id || 'NULL', '| count:', r.count, '| GP range:', r.min_gp, '-', r.max_gp, '| earliest:', r.earliest);
}

// Show what the non-good-batch opps look like
const legacyRemaining = await db.query(`
  SELECT recommended_drug_name, COUNT(*) as count,
    AVG(potential_margin_gain) as avg_gp,
    MIN(clinical_rationale) as sample_rationale
  FROM opportunities
  WHERE pharmacy_id = $1
    AND status = 'Not Submitted'
    AND (scan_batch_id IS NULL OR scan_batch_id != $2)
  GROUP BY recommended_drug_name
  ORDER BY count DESC
  LIMIT 20
`, [PARKWAY, GOOD_BATCH]);
console.log('\n=== Non-trigger-scan opps still in Parkway ===');
for (const r of legacyRemaining.rows) {
  console.log(r.recommended_drug_name, '| count:', r.count, '| avg GP:', parseFloat(r.avg_gp).toFixed(2), '| rationale:', (r.sample_rationale || '').substring(0, 80));
}

// Delete everything that's NOT from the good trigger scan batch
const deleted = await db.query(`
  DELETE FROM opportunities
  WHERE pharmacy_id = $1
    AND status = 'Not Submitted'
    AND (scan_batch_id IS NULL OR scan_batch_id != $2)
  RETURNING opportunity_id
`, [PARKWAY, GOOD_BATCH]);
console.log('\nDELETED:', deleted.rows.length, 'legacy/backfilled opps');

// Final count
const after = await db.query(`
  SELECT COUNT(*) as total,
    COUNT(trigger_id) as with_trigger
  FROM opportunities
  WHERE pharmacy_id = $1 AND status = 'Not Submitted'
`, [PARKWAY]);
console.log('\nFINAL:', after.rows[0]);

// Sample remaining to verify they're clean
const sample = await db.query(`
  SELECT recommended_drug_name, potential_margin_gain, scan_batch_id
  FROM opportunities
  WHERE pharmacy_id = $1 AND status = 'Not Submitted'
  ORDER BY random()
  LIMIT 5
`, [PARKWAY]);
console.log('\nSample remaining opps:');
for (const r of sample.rows) {
  console.log(' ', r.recommended_drug_name, '| GP:', r.potential_margin_gain, '| batch:', r.scan_batch_id);
}

process.exit(0);
