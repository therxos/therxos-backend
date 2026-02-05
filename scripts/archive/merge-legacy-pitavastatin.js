// Merge legacy Pitavastatin opportunities with the actual trigger
// Adds trigger_id, clinical_rationale from the trigger to legacy opps
// Skips duplicates (same patient + trigger_type + current_drug already exists)

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function mergeLegacyPitavastatin() {
  const client = await pool.connect();
  try {
    // 1. Find Pitavastatin trigger(s)
    const triggers = await client.query(`
      SELECT trigger_id, display_name, trigger_type, recommended_drug,
             clinical_rationale, action_instructions
      FROM triggers
      WHERE LOWER(display_name) LIKE '%pitavastatin%'
         OR LOWER(recommended_drug) LIKE '%pitavastatin%'
         OR LOWER(detection_keywords::text) LIKE '%pitavastatin%'
    `);

    if (triggers.rows.length === 0) {
      console.log('No Pitavastatin trigger found in triggers table.');
      return;
    }

    console.log(`Found ${triggers.rows.length} Pitavastatin trigger(s):`);
    for (const t of triggers.rows) {
      console.log(`  - ${t.display_name} (${t.trigger_id})`);
      console.log(`    Type: ${t.trigger_type}`);
      console.log(`    Recommended: ${t.recommended_drug}`);
      console.log(`    Has clinical_rationale: ${!!t.clinical_rationale}`);
      console.log(`    Has action_instructions: ${!!t.action_instructions}`);
    }

    // Use the first trigger (most relevant)
    const trigger = triggers.rows[0];
    const rationale = trigger.action_instructions || trigger.clinical_rationale;

    // 2. Find legacy opportunities matching Pitavastatin (no trigger_id)
    const legacyOpps = await client.query(`
      SELECT o.opportunity_id, o.patient_id, o.opportunity_type,
             o.current_drug_name, o.recommended_drug_name, o.status,
             o.clinical_rationale
      FROM opportunities o
      WHERE o.trigger_id IS NULL
        AND (
          LOWER(o.recommended_drug_name) LIKE '%pitavastatin%'
          OR LOWER(o.current_drug_name) LIKE '%pitavastatin%'
        )
    `);

    console.log(`\nFound ${legacyOpps.rows.length} legacy Pitavastatin opportunities (no trigger_id)`);

    if (legacyOpps.rows.length === 0) {
      console.log('Nothing to merge.');
      return;
    }

    // Show status breakdown
    const statusBreakdown = {};
    legacyOpps.rows.forEach(o => {
      statusBreakdown[o.status] = (statusBreakdown[o.status] || 0) + 1;
    });
    console.log('Status breakdown:', statusBreakdown);

    // 3. Find existing trigger-based opportunities to avoid duplicates
    const existingTriggerOpps = await client.query(`
      SELECT patient_id, UPPER(COALESCE(current_drug_name, '')) as drug
      FROM opportunities
      WHERE trigger_id = $1
    `, [trigger.trigger_id]);

    const existingSet = new Set(
      existingTriggerOpps.rows.map(r => `${r.patient_id}|${r.drug}`)
    );
    console.log(`\nExisting trigger-based opps: ${existingTriggerOpps.rows.length}`);

    // 4. Merge - update legacy opps to link to trigger
    let merged = 0;
    let skippedDuplicate = 0;
    let skippedActioned = 0;

    for (const opp of legacyOpps.rows) {
      const key = `${opp.patient_id}|${(opp.current_drug_name || '').toUpperCase()}`;

      if (existingSet.has(key)) {
        skippedDuplicate++;
        continue;
      }

      // Update the legacy opp to link to the trigger
      const updateFields = {
        trigger_id: trigger.trigger_id,
        opportunity_type: trigger.trigger_type || opp.opportunity_type,
      };

      // Only update clinical_rationale if current one is the generic fallback
      const currentRationale = (opp.clinical_rationale || '').toLowerCase();
      if (!currentRationale || currentRationale.includes('opportunity') && currentRationale.length < 50) {
        if (rationale) {
          updateFields.clinical_rationale = rationale;
        }
      }

      await client.query(`
        UPDATE opportunities
        SET trigger_id = $1,
            opportunity_type = $2,
            clinical_rationale = COALESCE($3, clinical_rationale),
            updated_at = NOW()
        WHERE opportunity_id = $4
      `, [
        updateFields.trigger_id,
        updateFields.opportunity_type,
        updateFields.clinical_rationale || null,
        opp.opportunity_id
      ]);

      existingSet.add(key); // Prevent self-duplication
      merged++;
    }

    console.log(`\nResults:`);
    console.log(`  Merged: ${merged}`);
    console.log(`  Skipped (duplicate): ${skippedDuplicate}`);
    console.log(`  Total legacy opps processed: ${legacyOpps.rows.length}`);

  } finally {
    client.release();
    await pool.end();
  }
}

mergeLegacyPitavastatin().catch(console.error);
