import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const heightsId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function fix() {
  console.log('Fixing ALL Heights opportunities...\n');

  // Get all triggers
  const triggers = await pool.query(`
    SELECT trigger_code, display_name, action_instructions, trigger_type,
           detection_keywords, recommended_drug
    FROM triggers WHERE is_enabled = true
  `);

  // Get all Heights opportunities
  const opps = await pool.query(`
    SELECT opportunity_id, clinical_rationale, opportunity_type, recommended_drug_name
    FROM opportunities WHERE pharmacy_id = $1
  `, [heightsId]);

  console.log(`Processing ${opps.rows.length} opportunities...`);

  let updated = 0;

  for (const opp of opps.rows) {
    // Skip if already has Action:
    if (opp.clinical_rationale?.includes('Action:')) continue;

    // Try to find matching trigger
    let matchedTrigger = null;
    const rationale = opp.clinical_rationale || '';

    for (const trigger of triggers.rows) {
      // Match by display_name in rationale
      if (trigger.display_name && rationale.includes(trigger.display_name)) {
        matchedTrigger = trigger;
        break;
      }
      // Match by recommended_drug
      if (trigger.recommended_drug && opp.recommended_drug_name?.includes(trigger.recommended_drug)) {
        matchedTrigger = trigger;
        break;
      }
      // Match by text after colon (e.g., "therapeutic_interchange: Pitivastatin")
      const colonIdx = rationale.indexOf(':');
      if (colonIdx > 0) {
        const afterColon = rationale.substring(colonIdx + 1).trim();
        if (trigger.display_name && afterColon.toLowerCase().includes(trigger.display_name.toLowerCase().substring(0, 10))) {
          matchedTrigger = trigger;
          break;
        }
      }
    }

    if (matchedTrigger && matchedTrigger.action_instructions) {
      const newRationale = (matchedTrigger.display_name || rationale) + '\n\nAction: ' + matchedTrigger.action_instructions;
      await pool.query(
        'UPDATE opportunities SET clinical_rationale = $1 WHERE opportunity_id = $2',
        [newRationale, opp.opportunity_id]
      );
      updated++;
    }
  }

  console.log(`Updated ${updated} opportunities`);

  // Check remaining without Action
  const remaining = await pool.query(`
    SELECT COUNT(*) as cnt FROM opportunities
    WHERE pharmacy_id = $1 AND clinical_rationale NOT LIKE '%Action:%'
  `, [heightsId]);
  console.log(`Remaining without Action: ${remaining.rows[0].cnt}`);

  await pool.end();
}

fix().catch(console.error);
