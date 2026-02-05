import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // Show unmatched opportunities and potential trigger matches
  const unmatched = await pool.query(`
    SELECT DISTINCT o.recommended_drug_name, o.opportunity_type,
      (SELECT t.trigger_id FROM triggers t
       WHERE t.trigger_type = o.opportunity_type
         AND LOWER(t.recommended_drug) = LOWER(o.recommended_drug_name)
       LIMIT 1) as exact_match,
      (SELECT t.trigger_id FROM triggers t
       WHERE t.trigger_type = o.opportunity_type
         AND (LOWER(o.recommended_drug_name) LIKE LOWER(t.recommended_drug) || '%'
              OR LOWER(t.recommended_drug) LIKE LOWER(o.recommended_drug_name) || '%')
       LIMIT 1) as prefix_match,
      (SELECT t.recommended_drug FROM triggers t
       WHERE t.trigger_type = o.opportunity_type
         AND (LOWER(o.recommended_drug_name) LIKE '%' || LEFT(LOWER(t.recommended_drug), 15) || '%'
              OR LOWER(t.recommended_drug) LIKE '%' || LEFT(LOWER(o.recommended_drug_name), 15) || '%')
       LIMIT 1) as fuzzy_trigger_drug,
      COUNT(*) as opp_count
    FROM opportunities o
    WHERE o.trigger_id IS NULL
    GROUP BY o.recommended_drug_name, o.opportunity_type
    ORDER BY opp_count DESC
    LIMIT 30
  `);

  console.log('=== Top unmatched recommended_drug_name values ===');
  for (const r of unmatched.rows) {
    console.log(`  "${r.recommended_drug_name}" (${r.opportunity_type}) x${r.opp_count}`);
    console.log(`    exact: ${r.exact_match || 'NONE'} | prefix: ${r.prefix_match || 'NONE'} | fuzzy_drug: ${r.fuzzy_trigger_drug || 'NONE'}`);
  }

  // Try a better backfill strategy: match on first 10 chars of recommended_drug
  const testBackfill = await pool.query(`
    SELECT COUNT(DISTINCT o.opportunity_id) as matchable
    FROM opportunities o
    JOIN triggers t ON t.trigger_type = o.opportunity_type
      AND (
        LOWER(o.recommended_drug_name) LIKE LOWER(t.recommended_drug) || '%'
        OR LOWER(t.recommended_drug) LIKE LOWER(o.recommended_drug_name) || '%'
      )
    WHERE o.trigger_id IS NULL
  `);
  console.log('\nPrefix match would backfill:', testBackfill.rows[0].matchable, 'more opportunities');

  // Check if prefix matching creates ambiguity (multiple trigger matches)
  const ambiguous = await pool.query(`
    SELECT o.recommended_drug_name, o.opportunity_type, COUNT(DISTINCT t.trigger_id) as trigger_matches
    FROM opportunities o
    JOIN triggers t ON t.trigger_type = o.opportunity_type
      AND (
        LOWER(o.recommended_drug_name) LIKE LOWER(t.recommended_drug) || '%'
        OR LOWER(t.recommended_drug) LIKE LOWER(o.recommended_drug_name) || '%'
      )
    WHERE o.trigger_id IS NULL
    GROUP BY o.recommended_drug_name, o.opportunity_type
    HAVING COUNT(DISTINCT t.trigger_id) > 1
  `);
  console.log('Ambiguous matches (multiple triggers):', ambiguous.rowCount);
  for (const r of ambiguous.rows) {
    console.log(`  "${r.recommended_drug_name}" (${r.opportunity_type}) -> ${r.trigger_matches} triggers`);
  }

  await pool.end();
}
run();
