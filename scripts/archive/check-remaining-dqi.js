import 'dotenv/config';
import db from './src/database/index.js';

// Check the 7 remaining pending DQIs
const dqi = await db.query(`
  SELECT dqi.issue_id, dqi.issue_type, dqi.issue_description, dqi.original_value, dqi.field_name,
    o.recommended_drug_name, o.prescriber_name, o.current_drug_name, o.status as opp_status,
    o.opportunity_id,
    ph.pharmacy_name,
    pr.prescriber_name as rx_prescriber, pr.prescriber_npi as rx_npi
  FROM data_quality_issues dqi
  JOIN opportunities o ON o.opportunity_id = dqi.opportunity_id
  LEFT JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
  LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
  WHERE dqi.status = 'pending'
`);
console.log('=== Remaining Pending DQIs ===');
for (const r of dqi.rows) {
  console.log('---');
  console.log('Type:', r.issue_type, '| Pharmacy:', r.pharmacy_name);
  console.log('Rec drug:', r.recommended_drug_name, '| Current:', r.current_drug_name);
  console.log('Opp prescriber:', r.prescriber_name, '| Rx prescriber:', r.rx_prescriber, '| NPI:', r.rx_npi);
  console.log('Opp status:', r.opp_status);
}

// Also check the DB trigger that creates DQIs
const trigger = await db.query(`
  SELECT tgname, tgtype, pg_get_triggerdef(oid) as definition
  FROM pg_trigger
  WHERE tgname LIKE '%data_quality%' OR tgname LIKE '%dqi%' OR tgname LIKE '%quality%'
`);
console.log('\n=== Data Quality Triggers ===');
for (const r of trigger.rows) {
  console.log(r.tgname, ':', r.definition);
}

process.exit(0);
