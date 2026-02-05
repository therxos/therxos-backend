import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function fix() {
  console.log('Fixing Heights opportunities with trigger actions...\n');

  // Get all triggers with their actions
  const triggers = await pool.query(`
    SELECT trigger_code, display_name, action_instructions, trigger_type
    FROM triggers WHERE is_enabled = true
  `);

  let updated = 0;

  for (const trigger of triggers.rows) {
    if (!trigger.action_instructions) continue;

    // Update opportunities that match this trigger's display_name in clinical_rationale
    const result = await pool.query(`
      UPDATE opportunities
      SET clinical_rationale = $1 || E'\n\nAction: ' || $2
      WHERE pharmacy_id = $3
      AND clinical_rationale LIKE '%' || $4 || '%'
      AND clinical_rationale NOT LIKE '%Action:%'
      RETURNING opportunity_id
    `, [
      trigger.display_name,
      trigger.action_instructions,
      heightsId,
      trigger.display_name
    ]);

    if (result.rows.length > 0) {
      console.log(`Updated ${result.rows.length} opps for: ${trigger.display_name}`);
      updated += result.rows.length;
    }
  }

  console.log(`\nTotal updated: ${updated}`);

  // Sample the results
  const sample = await pool.query(`
    SELECT clinical_rationale FROM opportunities
    WHERE pharmacy_id = $1
    AND clinical_rationale LIKE '%Action:%'
    LIMIT 3
  `, [heightsId]);

  console.log('\nSample results:');
  sample.rows.forEach((r, i) => {
    console.log(`--- Opp ${i + 1} ---`);
    console.log(r.clinical_rationale);
  });

  await pool.end();
}

fix().catch(console.error);
