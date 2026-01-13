import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function restore() {
  const pharmacyId = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'; // Bravo

  console.log('=== BEFORE RESTORATION ===');
  const before = await pool.query(`
    SELECT status, COUNT(*) as count, SUM(potential_margin_gain) as total_value
    FROM opportunities WHERE pharmacy_id = $1
    GROUP BY status ORDER BY count DESC
  `, [pharmacyId]);
  before.rows.forEach(r => console.log(`  ${r.status}: ${r.count} ($${parseFloat(r.total_value||0).toFixed(2)})`));

  // Restoration logic based on timestamps:
  // 1. If actioned_at exists and status is 'Not Submitted' -> should be at least 'Submitted'
  // 2. Use actioned_at date to determine if it's likely Approved/Completed vs Submitted

  console.log('\n=== ANALYZING DATA ===');

  // Find opportunities that have actioned_at but are showing as Not Submitted (these were overwritten)
  const wrongStatus = await pool.query(`
    SELECT opportunity_id, status, actioned_at, reviewed_at, staff_notes
    FROM opportunities
    WHERE pharmacy_id = $1
      AND status = 'Not Submitted'
      AND (actioned_at IS NOT NULL OR reviewed_at IS NOT NULL)
  `, [pharmacyId]);
  console.log(`Found ${wrongStatus.rows.length} opportunities with timestamps but showing 'Not Submitted'`);

  if (wrongStatus.rows.length > 0) {
    console.log('\n=== RESTORING ===');

    // Restore based on what we know:
    // - If actioned_at is set, it was worked on - set to Submitted at minimum
    // - If there are notes indicating approval/completion, set accordingly

    let submittedCount = 0;
    let approvedCount = 0;
    let completedCount = 0;

    for (const opp of wrongStatus.rows) {
      let newStatus = 'Submitted'; // Default for actioned items

      // Check notes for hints about actual status
      const notes = (opp.staff_notes || '').toLowerCase();
      if (notes.includes('complete') || notes.includes('filled') || notes.includes('done')) {
        newStatus = 'Completed';
        completedCount++;
      } else if (notes.includes('approv') || notes.includes('accepted')) {
        newStatus = 'Approved';
        approvedCount++;
      } else {
        submittedCount++;
      }

      await pool.query(`
        UPDATE opportunities SET status = $1 WHERE opportunity_id = $2
      `, [newStatus, opp.opportunity_id]);
    }

    console.log(`Restored to Submitted: ${submittedCount}`);
    console.log(`Restored to Approved: ${approvedCount}`);
    console.log(`Restored to Completed: ${completedCount}`);
  }

  console.log('\n=== AFTER RESTORATION ===');
  const after = await pool.query(`
    SELECT status, COUNT(*) as count, SUM(potential_margin_gain) as total_value
    FROM opportunities WHERE pharmacy_id = $1
    GROUP BY status ORDER BY count DESC
  `, [pharmacyId]);
  after.rows.forEach(r => console.log(`  ${r.status}: ${r.count} ($${parseFloat(r.total_value||0).toFixed(2)})`));

  // Calculate captured total
  const captured = after.rows
    .filter(r => r.status === 'Approved' || r.status === 'Completed')
    .reduce((sum, r) => sum + parseInt(r.count), 0);
  const capturedValue = after.rows
    .filter(r => r.status === 'Approved' || r.status === 'Completed')
    .reduce((sum, r) => sum + parseFloat(r.total_value || 0), 0);

  console.log(`\nTotal Captured (Approved + Completed): ${captured} ($${capturedValue.toFixed(2)})`);

  const submitted = after.rows.find(r => r.status === 'Submitted');
  console.log(`Total Submitted: ${submitted?.count || 0} ($${parseFloat(submitted?.total_value || 0).toFixed(2)})`);

  await pool.end();
}

restore().catch(console.error);
