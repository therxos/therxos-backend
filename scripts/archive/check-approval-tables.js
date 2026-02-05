import 'dotenv/config';
import db from './src/database/index.js';

const tables = ['pending_opportunity_types', 'opportunity_approval_log'];
for (const table of tables) {
  try {
    const r = await db.query(`SELECT COUNT(*) FROM ${table}`);
    console.log(table, ':', r.rows[0].count, 'rows');
  } catch (e) {
    console.log(table, ': ERROR -', e.message);
  }
}

// Try fetching a real pending_type_id
const sample = await db.query(`SELECT pending_type_id, recommended_drug_name FROM pending_opportunity_types LIMIT 3`);
console.log('\nSample items:');
for (const r of sample.rows) {
  console.log('  id:', r.pending_type_id, '| drug:', r.recommended_drug_name);
}

// Try the full detail query for one item
if (sample.rows.length > 0) {
  const id = sample.rows[0].pending_type_id;
  const drugName = sample.rows[0].recommended_drug_name;
  console.log('\nTesting detail queries for:', drugName);

  try {
    const q1 = await db.query(`SELECT * FROM pending_opportunity_types WHERE pending_type_id = $1`, [id]);
    console.log('1. pending_opportunity_types: OK');
  } catch(e) { console.log('1. pending_opportunity_types: FAIL -', e.message); }

  try {
    const q2 = await db.query(`
      SELECT o.opportunity_id FROM opportunities o WHERE o.recommended_drug_name = $1 LIMIT 1
    `, [drugName]);
    console.log('2. sample opps:', q2.rows.length > 0 ? 'found' : 'none');
  } catch(e) { console.log('2. sample opps: FAIL -', e.message); }

  try {
    const q3 = await db.query(`SELECT * FROM opportunity_approval_log WHERE pending_type_id = $1`, [id]);
    console.log('3. approval_log: OK,', q3.rows.length, 'rows');
  } catch(e) { console.log('3. approval_log: FAIL -', e.message); }
}

process.exit(0);
