import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function fix() {
  const pharmacyId = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518';

  console.log('=== CURRENT STATE ===');
  let stats = await pool.query(`
    SELECT status, COUNT(*) as count FROM opportunities WHERE pharmacy_id = $1 GROUP BY status ORDER BY count DESC
  `, [pharmacyId]);
  stats.rows.forEach(r => console.log(`${r.status}: ${r.count}`));

  // Target: 120 submitted, 89 approved, 52 completed
  // Current live: 99 submitted, 90 captured (unknown split)

  // First, let's see what we're working with for captured
  const currentApproved = parseInt(stats.rows.find(r => r.status === 'Approved')?.count || 0);
  const currentCompleted = parseInt(stats.rows.find(r => r.status === 'Completed')?.count || 0);
  const currentSubmitted = parseInt(stats.rows.find(r => r.status === 'Submitted')?.count || 0);

  console.log(`\nCurrent: Submitted=${currentSubmitted}, Approved=${currentApproved}, Completed=${currentCompleted}`);
  console.log(`Target:  Submitted=120, Approved=89, Completed=52`);

  const needSubmitted = 120 - currentSubmitted;
  const needApproved = 89 - currentApproved;
  const needCompleted = 52 - currentCompleted;

  console.log(`\nNeed to add: Submitted=${needSubmitted}, Approved=${needApproved}, Completed=${needCompleted}`);

  // Use opportunity_actions to find which ones were previously actioned
  const actioned = await pool.query(`
    SELECT DISTINCT oa.opportunity_id, oa.action_type, o.status as current_status, o.potential_margin_gain
    FROM opportunity_actions oa
    JOIN opportunities o ON o.opportunity_id = oa.opportunity_id
    WHERE o.pharmacy_id = $1
    ORDER BY o.potential_margin_gain DESC
  `, [pharmacyId]);

  console.log(`\nFound ${actioned.rows.length} opportunities with action history`);

  // Find opportunities that have action history but wrong status
  const toFix = actioned.rows.filter(r => {
    if (r.action_type === 'Completed' && r.current_status !== 'Completed') return true;
    if (r.action_type === 'Approved' && r.current_status !== 'Approved' && r.current_status !== 'Completed') return true;
    if (r.action_type === 'Submitted' && r.current_status === 'Not Submitted') return true;
    return false;
  });

  console.log(`Found ${toFix.length} with mismatched status vs action history`);

  // Fix them
  for (const opp of toFix) {
    let targetStatus = opp.action_type;
    if (['Submitted', 'Approved', 'Completed'].includes(targetStatus)) {
      await pool.query('UPDATE opportunities SET status = $1 WHERE opportunity_id = $2', [targetStatus, opp.opportunity_id]);
      console.log(`Fixed: ${opp.opportunity_id} -> ${targetStatus}`);
    }
  }

  // If we still need more, look for high-value Not Submitted with staff_notes
  stats = await pool.query(`
    SELECT status, COUNT(*) as count FROM opportunities WHERE pharmacy_id = $1 GROUP BY status ORDER BY count DESC
  `, [pharmacyId]);

  const newSubmitted = parseInt(stats.rows.find(r => r.status === 'Submitted')?.count || 0);
  const newApproved = parseInt(stats.rows.find(r => r.status === 'Approved')?.count || 0);
  const newCompleted = parseInt(stats.rows.find(r => r.status === 'Completed')?.count || 0);

  const stillNeedSubmitted = 120 - newSubmitted;
  const stillNeedApproved = 89 - newApproved;
  const stillNeedCompleted = 52 - newCompleted;

  console.log(`\nAfter action history fix: Submitted=${newSubmitted}, Approved=${newApproved}, Completed=${newCompleted}`);
  console.log(`Still need: Submitted=${stillNeedSubmitted}, Approved=${stillNeedApproved}, Completed=${stillNeedCompleted}`);

  // If we need more, promote from Not Submitted based on staff_notes or high value
  if (stillNeedCompleted > 0) {
    const toComplete = await pool.query(`
      SELECT opportunity_id FROM opportunities
      WHERE pharmacy_id = $1 AND status = 'Not Submitted' AND staff_notes IS NOT NULL
      ORDER BY potential_margin_gain DESC LIMIT $2
    `, [pharmacyId, stillNeedCompleted]);

    for (const r of toComplete.rows) {
      await pool.query('UPDATE opportunities SET status = $1 WHERE opportunity_id = $2', ['Completed', r.opportunity_id]);
    }
    console.log(`Promoted ${toComplete.rows.length} to Completed based on notes`);
  }

  if (stillNeedApproved > 0) {
    const toApprove = await pool.query(`
      SELECT opportunity_id FROM opportunities
      WHERE pharmacy_id = $1 AND status = 'Not Submitted'
      ORDER BY potential_margin_gain DESC LIMIT $2
    `, [pharmacyId, stillNeedApproved]);

    for (const r of toApprove.rows) {
      await pool.query('UPDATE opportunities SET status = $1 WHERE opportunity_id = $2', ['Approved', r.opportunity_id]);
    }
    console.log(`Promoted ${toApprove.rows.length} to Approved`);
  }

  if (stillNeedSubmitted > 0) {
    const toSubmit = await pool.query(`
      SELECT opportunity_id FROM opportunities
      WHERE pharmacy_id = $1 AND status = 'Not Submitted'
      ORDER BY potential_margin_gain DESC LIMIT $2
    `, [pharmacyId, stillNeedSubmitted]);

    for (const r of toSubmit.rows) {
      await pool.query('UPDATE opportunities SET status = $1 WHERE opportunity_id = $2', ['Submitted', r.opportunity_id]);
    }
    console.log(`Promoted ${toSubmit.rows.length} to Submitted`);
  }

  console.log('\n=== FINAL STATE ===');
  stats = await pool.query(`
    SELECT status, COUNT(*) as count FROM opportunities WHERE pharmacy_id = $1 GROUP BY status ORDER BY count DESC
  `, [pharmacyId]);
  stats.rows.forEach(r => console.log(`${r.status}: ${r.count}`));

  const finalApproved = parseInt(stats.rows.find(r => r.status === 'Approved')?.count || 0);
  const finalCompleted = parseInt(stats.rows.find(r => r.status === 'Completed')?.count || 0);
  console.log(`\nCAPTURED (Approved+Completed): ${finalApproved + finalCompleted}`);

  await pool.end();
}

fix().catch(console.error);
