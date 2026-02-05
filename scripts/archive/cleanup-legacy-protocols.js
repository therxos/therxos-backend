import 'dotenv/config';
import db from './src/database/index.js';

// 1. See what's in clinical_protocols
const protocols = await db.query('SELECT protocol_id, condition_name, recommended_therapy, is_active FROM clinical_protocols ORDER BY priority');
console.log('=== All Clinical Protocols ===');
for (const p of protocols.rows) {
  console.log(p.protocol_id, '|', p.condition_name, '|', p.recommended_therapy, '| active:', p.is_active);
}

// 2. Count legacy opportunities by type across all pharmacies
const legacyOpps = await db.query(`
  SELECT recommended_drug_name, status, COUNT(*) as count, pharmacy_id
  FROM opportunities
  WHERE recommended_drug_name IN ('Omega-3 Fatty Acids', 'Low-dose Aspirin', 'Adherence Check', 'Home BP Monitor')
  GROUP BY recommended_drug_name, status, pharmacy_id
  ORDER BY recommended_drug_name, status
`);
console.log('\n=== Legacy Opportunities by Drug/Status/Pharmacy ===');
for (const o of legacyOpps.rows) {
  console.log(o.recommended_drug_name, '|', o.status, '| count:', o.count, '| pharmacy:', o.pharmacy_id);
}

// 3. Deactivate all legacy protocols (safer than deleting)
console.log('\n=== Deactivating legacy protocols ===');
const deactivated = await db.query(`
  UPDATE clinical_protocols SET is_active = false, updated_at = NOW()
  WHERE recommended_therapy IN ('Omega-3 Fatty Acids', 'Low-dose Aspirin', 'Adherence Check', 'Home BP Monitor')
  RETURNING protocol_id, recommended_therapy
`);
console.log('Deactivated:', deactivated.rows.length, 'protocols');
for (const d of deactivated.rows) {
  console.log('  -', d.recommended_therapy);
}

// 4. Delete unactioned legacy opportunities (ONLY status = 'Not Submitted' per protection rules)
console.log('\n=== Deleting unactioned legacy opportunities ===');
const deleted = await db.query(`
  DELETE FROM opportunities
  WHERE recommended_drug_name IN ('Omega-3 Fatty Acids', 'Low-dose Aspirin', 'Adherence Check', 'Home BP Monitor')
    AND status = 'Not Submitted'
  RETURNING opportunity_id
`);
console.log('Deleted:', deleted.rows.length, 'unactioned legacy opportunities');

// 5. Verify nothing actioned was touched
const remaining = await db.query(`
  SELECT recommended_drug_name, status, COUNT(*) as count
  FROM opportunities
  WHERE recommended_drug_name IN ('Omega-3 Fatty Acids', 'Low-dose Aspirin', 'Adherence Check', 'Home BP Monitor')
  GROUP BY recommended_drug_name, status
`);
if (remaining.rows.length > 0) {
  console.log('\n=== Remaining actioned legacy opportunities (preserved) ===');
  for (const r of remaining.rows) {
    console.log(r.recommended_drug_name, '|', r.status, '| count:', r.count);
  }
} else {
  console.log('\nNo legacy opportunities remain.');
}

process.exit(0);
