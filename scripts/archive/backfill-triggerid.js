import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // Round 1: Prefix match (opp drug starts with trigger drug, or vice versa)
  const r1 = await pool.query(`
    UPDATE opportunities o
    SET trigger_id = sub.trigger_id
    FROM (
      SELECT DISTINCT ON (o2.opportunity_id) o2.opportunity_id, t.trigger_id
      FROM opportunities o2
      JOIN triggers t ON t.trigger_type = o2.opportunity_type
        AND (
          LOWER(o2.recommended_drug_name) LIKE LOWER(t.recommended_drug) || '%'
          OR LOWER(t.recommended_drug) LIKE LOWER(o2.recommended_drug_name) || '%'
        )
      WHERE o2.trigger_id IS NULL
      ORDER BY o2.opportunity_id, LENGTH(t.recommended_drug) DESC
    ) sub
    WHERE o.opportunity_id = sub.opportunity_id
  `);
  console.log('Round 1 (prefix match):', r1.rowCount, 'updated');

  // Round 2: Fuzzy match - first 10 chars of drug name
  const r2 = await pool.query(`
    UPDATE opportunities o
    SET trigger_id = sub.trigger_id
    FROM (
      SELECT DISTINCT ON (o2.opportunity_id) o2.opportunity_id, t.trigger_id
      FROM opportunities o2
      JOIN triggers t ON t.trigger_type = o2.opportunity_type
        AND LEFT(LOWER(o2.recommended_drug_name), 10) = LEFT(LOWER(t.recommended_drug), 10)
        AND LENGTH(t.recommended_drug) >= 5
      WHERE o2.trigger_id IS NULL
      ORDER BY o2.opportunity_id, LENGTH(t.recommended_drug) DESC
    ) sub
    WHERE o.opportunity_id = sub.opportunity_id
  `);
  console.log('Round 2 (first-10-chars match):', r2.rowCount, 'updated');

  // Round 3: LIKE with first word match (for combo drugs like "Amlodipine-Atorvastatin" vs "Amlodipine-Atorvastatin")
  const r3 = await pool.query(`
    UPDATE opportunities o
    SET trigger_id = sub.trigger_id
    FROM (
      SELECT DISTINCT ON (o2.opportunity_id) o2.opportunity_id, t.trigger_id
      FROM opportunities o2
      JOIN triggers t ON t.trigger_type = o2.opportunity_type
        AND LOWER(o2.recommended_drug_name) LIKE '%' || LEFT(LOWER(t.recommended_drug), 8) || '%'
        AND LENGTH(t.recommended_drug) >= 8
      WHERE o2.trigger_id IS NULL
      ORDER BY o2.opportunity_id, LENGTH(t.recommended_drug) DESC
    ) sub
    WHERE o.opportunity_id = sub.opportunity_id
  `);
  console.log('Round 3 (contains first-8-chars):', r3.rowCount, 'updated');

  // Final stats
  const stats = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(trigger_id) as with_trigger,
      COUNT(*) - COUNT(trigger_id) as without_trigger
    FROM opportunities
  `);
  console.log('\nFinal stats:', stats.rows[0]);

  // Bravo-specific stats
  const bravoId = (await pool.query("SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%' LIMIT 1")).rows[0].pharmacy_id;
  const bravoStats = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(trigger_id) as with_trigger,
      COUNT(*) - COUNT(trigger_id) as without_trigger
    FROM opportunities WHERE pharmacy_id = $1
  `, [bravoId]);
  console.log('Bravo stats:', bravoStats.rows[0]);

  // Show remaining unmatched for Bravo
  const remaining = await pool.query(`
    SELECT recommended_drug_name, COUNT(*) as cnt
    FROM opportunities
    WHERE trigger_id IS NULL AND pharmacy_id = $1
    GROUP BY recommended_drug_name
    ORDER BY cnt DESC
    LIMIT 15
  `, [bravoId]);
  console.log('\nRemaining unmatched in Bravo:');
  for (const r of remaining.rows) {
    console.log('  "' + r.recommended_drug_name + '" x' + r.cnt);
  }

  await pool.end();
}
run();
