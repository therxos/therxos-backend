import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // Check unmatched opps that SHOULD have triggers (their drug names exist in triggers)
  const missing = await pool.query(`
    SELECT DISTINCT o.recommended_drug_name, o.opportunity_type, t.recommended_drug, t.trigger_id, t.display_name
    FROM opportunities o
    CROSS JOIN triggers t
    WHERE o.trigger_id IS NULL
      AND t.trigger_type = o.opportunity_type
      AND t.is_enabled = true
      AND o.pharmacy_id = (SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%' LIMIT 1)
    ORDER BY o.recommended_drug_name
    LIMIT 40
  `);

  console.log('=== Opportunities without trigger_id where same opportunity_type exists ===');
  for (const r of missing.rows) {
    console.log(`  Opp: "${r.recommended_drug_name}" (${r.opportunity_type})`);
    console.log(`  Trigger: "${r.recommended_drug}" -> ${r.display_name} (${r.trigger_id})`);
    console.log('');
  }

  // Specifically check the ones the user mentioned
  const checks = ['Ceterizine Chewable', 'Comfort EZ Alcohol', 'Pure Comfort', 'Omega'];
  for (const drug of checks) {
    const t = await pool.query(`
      SELECT trigger_id, trigger_type, recommended_drug, display_name
      FROM triggers WHERE is_enabled = true AND recommended_drug ILIKE $1
    `, ['%' + drug + '%']);
    console.log(`Trigger for "${drug}":`, t.rows.map(r => `${r.recommended_drug} (${r.trigger_type}, ${r.trigger_id})`));
  }

  await pool.end();
}
run();
