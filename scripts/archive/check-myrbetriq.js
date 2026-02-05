import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Find Myrbetriq trigger
  const trigger = await pool.query(`
    SELECT trigger_id, display_name, default_gp_value, synced_at, recommended_drug
    FROM triggers WHERE display_name ILIKE '%myrbetriq%' OR display_name ILIKE '%mirabegron%'
  `);
  console.log('=== Myrbetriq Triggers ===');
  for (const t of trigger.rows) {
    console.log(`  ${t.display_name} | GP: ${t.default_gp_value} | Synced: ${t.synced_at} | Rec: ${t.recommended_drug}`);
  }

  if (trigger.rows.length > 0) {
    const triggerId = trigger.rows[0].trigger_id;

    // Check opportunities created for this trigger
    const opps = await pool.query(`
      SELECT o.status, o.annual_margin_gain, o.potential_margin_gain,
             o.current_drug_name, o.recommended_drug_name,
             ph.pharmacy_name,
             p.first_name, p.last_name
      FROM opportunities o
      JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      WHERE o.trigger_id = $1
      ORDER BY o.created_at DESC
      LIMIT 20
    `, [triggerId]);

    console.log(`\n=== Opportunities (${opps.rows.length} found) ===`);
    for (const o of opps.rows) {
      console.log(`  ${o.pharmacy_name} | ${o.first_name} ${o.last_name} | ${o.current_drug_name} -> ${o.recommended_drug_name} | Status: ${o.status} | GP: $${o.potential_margin_gain} | Annual: $${o.annual_margin_gain}`);
    }

    // Count by status
    const counts = await pool.query(`
      SELECT status, COUNT(*) as cnt
      FROM opportunities WHERE trigger_id = $1
      GROUP BY status
    `, [triggerId]);
    console.log('\n=== Status Counts ===');
    for (const c of counts.rows) {
      console.log(`  ${c.status}: ${c.cnt}`);
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
