require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Find all actioned duplicate groups
  const dupes = await pool.query(`
    WITH dupe_groups AS (
      SELECT pharmacy_id, patient_id, UPPER(COALESCE(recommended_drug_name, '')) as drug
      FROM opportunities
      WHERE status NOT IN ('Denied', 'Declined')
      GROUP BY 1, 2, 3
      HAVING COUNT(*) > 1
    )
    SELECT
      o.opportunity_id,
      p.pharmacy_name,
      pat.first_name || ' ' || pat.last_name as patient,
      o.recommended_drug_name,
      o.status,
      o.annual_margin_gain,
      o.created_at,
      o.actioned_at
    FROM opportunities o
    JOIN dupe_groups d ON d.pharmacy_id = o.pharmacy_id
      AND d.patient_id = o.patient_id
      AND UPPER(COALESCE(o.recommended_drug_name, '')) = d.drug
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    LEFT JOIN patients pat ON pat.patient_id = o.patient_id
    WHERE o.status NOT IN ('Denied', 'Declined')
    ORDER BY p.pharmacy_name, pat.last_name, o.recommended_drug_name,
      CASE WHEN o.status != 'Not Submitted' THEN 0 ELSE 1 END,
      o.annual_margin_gain DESC NULLS LAST
  `);

  console.log(`Found ${dupes.rows.length} opportunities in ${dupes.rows.length} duplicate groups\n`);

  // Group by patient + drug
  const groups = new Map();
  for (const row of dupes.rows) {
    const key = `${row.pharmacy_name}|${row.patient}|${row.recommended_drug_name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  console.log(`\n${groups.size} duplicate groups with actioned opportunities:\n`);

  let toDelete = [];

  for (const [key, opps] of groups) {
    // Keep the first one (best - actioned with highest margin)
    const keep = opps[0];
    const rest = opps.slice(1);

    console.log(`${key}`);
    console.log(`  KEEP: ${keep.status} | $${keep.annual_margin_gain}/yr | ${keep.opportunity_id.slice(0,8)}`);

    for (const opp of rest) {
      if (opp.status === 'Not Submitted') {
        console.log(`  DELETE: ${opp.status} | $${opp.annual_margin_gain}/yr | ${opp.opportunity_id.slice(0,8)}`);
        toDelete.push(opp.opportunity_id);
      } else {
        console.log(`  ACTIONED (needs merge): ${opp.status} | $${opp.annual_margin_gain}/yr | ${opp.opportunity_id.slice(0,8)}`);
      }
    }
    console.log('');
  }

  console.log(`\nCan auto-delete ${toDelete.length} Not Submitted duplicates`);

  if (toDelete.length > 0) {
    const result = await pool.query(`
      DELETE FROM opportunities WHERE opportunity_id = ANY($1) AND status = 'Not Submitted'
      RETURNING opportunity_id
    `, [toDelete]);
    console.log(`Deleted ${result.rowCount} Not Submitted duplicates`);
  }

  // Check remaining
  const remaining = await pool.query(`
    SELECT COUNT(*) as cnt FROM (
      SELECT pharmacy_id, patient_id, UPPER(COALESCE(recommended_drug_name, '')) as drug
      FROM opportunities
      WHERE status NOT IN ('Denied', 'Declined')
      GROUP BY 1, 2, 3
      HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`\nRemaining actioned duplicate groups: ${remaining.rows[0].cnt}`);

  await pool.end();
}

run().catch(e => console.error(e));
