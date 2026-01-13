import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function analyze() {
  const pharmacyId = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'; // Bravo

  // Target: 142 captured worth ~$79K, 121+ submitted
  // Current: 141 captured worth $12K, 120 submitted
  // Missing: ~$67K worth of captured value

  console.log('=== CURRENT STATE ===');
  const current = await pool.query(`
    SELECT status, COUNT(*) as count, SUM(potential_margin_gain) as total_value
    FROM opportunities WHERE pharmacy_id = $1
    GROUP BY status ORDER BY total_value DESC
  `, [pharmacyId]);
  current.rows.forEach(r => console.log(`  ${r.status}: ${r.count} ($${parseFloat(r.total_value||0).toFixed(2)})`));

  // The $79K captured means high-value opps were marked as captured
  // These are likely now in "Not Submitted"
  // Let's look at the highest value Not Submitted ones

  console.log('\n=== TOP 20 "Not Submitted" BY VALUE ===');
  const topNotSubmitted = await pool.query(`
    SELECT opportunity_id, recommended_drug_name, potential_margin_gain, created_at, updated_at
    FROM opportunities
    WHERE pharmacy_id = $1 AND status = 'Not Submitted'
    ORDER BY potential_margin_gain DESC
    LIMIT 20
  `, [pharmacyId]);
  topNotSubmitted.rows.forEach(r => {
    console.log(`  $${parseFloat(r.potential_margin_gain).toFixed(2)} - ${r.recommended_drug_name} (updated: ${r.updated_at?.toISOString().split('T')[0]})`);
  });

  // Check for any audit trail or action history
  console.log('\n=== CHECKING OPPORTUNITY_ACTIONS TABLE ===');
  const actions = await pool.query(`
    SELECT oa.opportunity_id, oa.action_type, oa.performed_at, o.status as current_status
    FROM opportunity_actions oa
    JOIN opportunities o ON o.opportunity_id = oa.opportunity_id
    WHERE o.pharmacy_id = $1
    ORDER BY oa.performed_at DESC
    LIMIT 30
  `, [pharmacyId]);

  if (actions.rows.length > 0) {
    console.log(`Found ${actions.rows.length} action records:`);
    actions.rows.forEach(r => {
      console.log(`  ${r.action_type} -> currently ${r.current_status} (at ${r.performed_at?.toISOString()})`);
    });

    // Find opportunities that have action history but are now "Not Submitted"
    const mismatch = await pool.query(`
      SELECT DISTINCT oa.opportunity_id, oa.action_type, o.status, o.potential_margin_gain, o.recommended_drug_name
      FROM opportunity_actions oa
      JOIN opportunities o ON o.opportunity_id = oa.opportunity_id
      WHERE o.pharmacy_id = $1
        AND o.status = 'Not Submitted'
        AND oa.action_type IN ('Submitted', 'Approved', 'Completed')
    `, [pharmacyId]);

    if (mismatch.rows.length > 0) {
      console.log(`\n=== FOUND ${mismatch.rows.length} OPPORTUNITIES WITH ACTION HISTORY BUT "Not Submitted" ===`);
      let totalValue = 0;
      mismatch.rows.forEach(r => {
        totalValue += parseFloat(r.potential_margin_gain || 0);
        console.log(`  ${r.action_type} -> ${r.status}: $${parseFloat(r.potential_margin_gain).toFixed(2)} - ${r.recommended_drug_name}`);
      });
      console.log(`Total value that should be restored: $${totalValue.toFixed(2)}`);
    }
  } else {
    console.log('No action records found');
  }

  // Also check staff_notes for any clues
  console.log('\n=== "Not Submitted" WITH STAFF NOTES ===');
  const withNotes = await pool.query(`
    SELECT opportunity_id, recommended_drug_name, potential_margin_gain, staff_notes
    FROM opportunities
    WHERE pharmacy_id = $1 AND status = 'Not Submitted' AND staff_notes IS NOT NULL AND staff_notes != ''
    ORDER BY potential_margin_gain DESC
    LIMIT 20
  `, [pharmacyId]);

  if (withNotes.rows.length > 0) {
    let notesTotal = 0;
    withNotes.rows.forEach(r => {
      notesTotal += parseFloat(r.potential_margin_gain || 0);
      console.log(`  $${parseFloat(r.potential_margin_gain).toFixed(2)} - ${r.recommended_drug_name}`);
      console.log(`    Notes: ${r.staff_notes?.substring(0, 100)}`);
    });
    console.log(`\nTotal value of Not Submitted with notes: $${notesTotal.toFixed(2)}`);
  }

  await pool.end();
}

analyze().catch(console.error);
