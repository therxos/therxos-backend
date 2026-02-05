require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function checkDuplicates() {
  // Get live clients (not demo)
  const liveClients = await pool.query(`
    SELECT client_id, client_name
    FROM clients
    WHERE status IN ('active', 'onboarding')
      AND client_name NOT ILIKE '%marvel%'
      AND client_name NOT ILIKE '%hero%'
      AND client_name NOT ILIKE '%demo%'
  `);

  console.log('Live clients:', liveClients.rows.map(r => r.client_name).join(', '));
  console.log('');

  // Find Pitavastatin duplicates specifically
  console.log('PITAVASTATIN DUPLICATES WITH DIFFERENT QUANTITIES:');
  console.log('===================================================');
  const pitavDupes = await pool.query(`
    SELECT
      p.pharmacy_name,
      pat.first_name || ' ' || pat.last_name as patient_name,
      o.recommended_drug_name,
      o.avg_dispensed_qty,
      o.annual_margin_gain,
      o.status,
      o.opportunity_id,
      o.created_at
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    JOIN clients c ON c.client_id = p.client_id
    LEFT JOIN patients pat ON pat.patient_id = o.patient_id
    WHERE c.status IN ('active', 'onboarding')
      AND c.client_name NOT ILIKE '%marvel%'
      AND c.client_name NOT ILIKE '%hero%'
      AND (o.recommended_drug_name ILIKE '%pitav%' OR o.recommended_drug ILIKE '%pitav%')
    ORDER BY p.pharmacy_name, pat.last_name, pat.first_name, o.avg_dispensed_qty
  `);

  let lastKey = '';
  for (const row of pitavDupes.rows) {
    const key = `${row.pharmacy_name}|${row.patient_name}`;
    if (key !== lastKey) {
      console.log(`\n${row.pharmacy_name} | ${row.patient_name}:`);
      lastKey = key;
    }
    console.log(`  Qty: ${row.avg_dispensed_qty} | $${row.annual_margin_gain}/yr | ${row.status} | ${row.opportunity_id.slice(0,8)}`);
  }

  // Find all duplicates by patient + recommended_drug
  console.log('\n\nALL DUPLICATES (same patient + recommended_drug):');
  console.log('==================================================');
  const dupes = await pool.query(`
    SELECT
      o.pharmacy_id,
      p.pharmacy_name,
      o.patient_id,
      pat.first_name || ' ' || pat.last_name as patient_name,
      o.recommended_drug_name,
      COUNT(*) as dupe_count,
      array_agg(DISTINCT o.avg_dispensed_qty) as qtys,
      array_agg(o.status ORDER BY o.created_at) as statuses
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    JOIN clients c ON c.client_id = p.client_id
    LEFT JOIN patients pat ON pat.patient_id = o.patient_id
    WHERE c.status IN ('active', 'onboarding')
      AND c.client_name NOT ILIKE '%marvel%'
      AND c.client_name NOT ILIKE '%hero%'
      AND c.client_name NOT ILIKE '%demo%'
    GROUP BY o.pharmacy_id, p.pharmacy_name, o.patient_id, pat.first_name, pat.last_name, o.recommended_drug_name
    HAVING COUNT(*) > 1
    ORDER BY dupe_count DESC
    LIMIT 30
  `);

  for (const row of dupes.rows) {
    console.log(`${row.pharmacy_name} | ${row.patient_name} | ${row.recommended_drug_name}`);
    console.log(`  Count: ${row.dupe_count} | Qtys: ${row.qtys.join(', ')} | Statuses: ${row.statuses.join(', ')}`);
  }

  // Summary
  const summary = await pool.query(`
    WITH dupe_groups AS (
      SELECT pharmacy_id, patient_id, recommended_drug_name
      FROM opportunities
      GROUP BY pharmacy_id, patient_id, recommended_drug_name
      HAVING COUNT(*) > 1
    )
    SELECT
      p.pharmacy_name,
      COUNT(*) as total_in_dupe_groups,
      COUNT(DISTINCT (o.patient_id, o.recommended_drug_name)) as dupe_group_count
    FROM dupe_groups d
    JOIN opportunities o ON o.pharmacy_id = d.pharmacy_id
      AND o.patient_id = d.patient_id
      AND COALESCE(o.recommended_drug_name,'') = COALESCE(d.recommended_drug_name,'')
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    JOIN clients c ON c.client_id = p.client_id
    WHERE c.status IN ('active', 'onboarding')
      AND c.client_name NOT ILIKE '%marvel%'
    GROUP BY p.pharmacy_name
    ORDER BY total_in_dupe_groups DESC
  `);

  console.log('\n\nSUMMARY BY PHARMACY:');
  console.log('====================');
  for (const row of summary.rows) {
    console.log(`${row.pharmacy_name}: ${row.total_in_dupe_groups} opps in ${row.dupe_group_count} duplicate groups`);
  }

  await pool.end();
}

checkDuplicates().catch(e => console.error(e));
