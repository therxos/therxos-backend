import 'dotenv/config';
import db from './src/database/index.js';

// Find opportunities missing trigger_id and try to match them to triggers
const missing = await db.query(`
  SELECT o.pharmacy_id, COUNT(*) as count
  FROM opportunities o
  WHERE o.trigger_id IS NULL
    AND o.status = 'Not Submitted'
  GROUP BY o.pharmacy_id
  ORDER BY count DESC
`);
console.log('=== Opportunities missing trigger_id ===');
for (const r of missing.rows) {
  console.log('pharmacy:', r.pharmacy_id, '| count:', r.count);
}

// Get all triggers for matching
const triggers = await db.query(`
  SELECT trigger_id, recommended_drug, display_name, detection_keywords, trigger_type
  FROM triggers
  WHERE is_enabled = true
`);
console.log('\nLoaded', triggers.rows.length, 'triggers for matching');

// Match opportunities to triggers by recommended_drug_name
let updated = 0;
let unmatched = 0;

const opps = await db.query(`
  SELECT o.opportunity_id, o.recommended_drug_name, o.opportunity_type
  FROM opportunities o
  WHERE o.trigger_id IS NULL
    AND o.status = 'Not Submitted'
`);

for (const opp of opps.rows) {
  const recDrug = (opp.recommended_drug_name || '').toUpperCase();

  // Try exact match on recommended_drug
  let match = triggers.rows.find(t =>
    (t.recommended_drug || '').toUpperCase() === recDrug
  );

  // Try display_name match
  if (!match) {
    match = triggers.rows.find(t =>
      (t.display_name || '').toUpperCase() === recDrug
    );
  }

  // Try partial match - recommended_drug contains or is contained
  if (!match) {
    match = triggers.rows.find(t => {
      const trigDrug = (t.recommended_drug || '').toUpperCase();
      return trigDrug && (recDrug.includes(trigDrug) || trigDrug.includes(recDrug));
    });
  }

  if (match) {
    await db.query(`UPDATE opportunities SET trigger_id = $1 WHERE opportunity_id = $2`, [match.trigger_id, opp.opportunity_id]);
    updated++;
  } else {
    unmatched++;
  }
}

console.log('\nUpdated:', updated, 'opportunities with trigger_id');
console.log('Unmatched:', unmatched, 'opportunities (no matching trigger found)');

// Show unmatched drug names
if (unmatched > 0) {
  const unmatchedDrugs = await db.query(`
    SELECT DISTINCT recommended_drug_name, COUNT(*) as count
    FROM opportunities
    WHERE trigger_id IS NULL AND status = 'Not Submitted'
    GROUP BY recommended_drug_name
    ORDER BY count DESC
    LIMIT 20
  `);
  console.log('\nUnmatched drug names:');
  for (const r of unmatchedDrugs.rows) {
    console.log(' ', r.recommended_drug_name, ':', r.count);
  }
}

process.exit(0);
