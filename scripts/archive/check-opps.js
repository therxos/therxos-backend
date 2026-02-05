import db from './src/database/index.js';

async function check() {
  // Total opps
  const total = await db.query('SELECT COUNT(*) as cnt FROM opportunities');
  console.log('Total opportunities:', total.rows[0].cnt);

  // By pharmacy
  const byPharm = await db.query(`
    SELECT p.pharmacy_name, COUNT(*) as cnt
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    GROUP BY p.pharmacy_name
    ORDER BY cnt DESC
  `);
  console.log('\nBy pharmacy:');
  byPharm.rows.forEach(r => console.log('  ', r.pharmacy_name, ':', r.cnt));

  // By status
  const byStatus = await db.query(`
    SELECT status, COUNT(*) as cnt
    FROM opportunities
    GROUP BY status
    ORDER BY cnt DESC
  `);
  console.log('\nBy status:');
  byStatus.rows.forEach(r => console.log('  ', r.status, ':', r.cnt));

  // Recent opps (last 2 hours)
  const recent = await db.query(`
    SELECT COUNT(*) as cnt, MIN(created_at) as earliest, MAX(created_at) as latest
    FROM opportunities
    WHERE created_at > NOW() - INTERVAL '2 hours'
  `);
  console.log('\nCreated in last 2 hours:', recent.rows[0].cnt);
  console.log('  From:', recent.rows[0].earliest);
  console.log('  To:', recent.rows[0].latest);

  // What was the count before the recent scan?
  const beforeScan = await db.query(`
    SELECT COUNT(*) as cnt FROM opportunities
    WHERE created_at <= NOW() - INTERVAL '2 hours'
  `);
  console.log('\nOpps before last 2 hours:', beforeScan.rows[0].cnt);

  // Check for massive duplication - same patient+trigger combos
  const dupes = await db.query(`
    SELECT patient_id, trigger_id, COUNT(*) as cnt
    FROM opportunities
    WHERE status = 'Not Submitted'
    GROUP BY patient_id, trigger_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `);
  console.log('\nTop duplicate patient+trigger combos (Not Submitted only):');
  dupes.rows.forEach(r => console.log('  patient:', r.patient_id, 'trigger:', r.trigger_id, 'count:', r.cnt));

  const totalDupes = await db.query(`
    SELECT SUM(cnt - 1) as excess FROM (
      SELECT patient_id, trigger_id, COUNT(*) as cnt
      FROM opportunities
      WHERE status = 'Not Submitted'
      GROUP BY patient_id, trigger_id
      HAVING COUNT(*) > 1
    ) sub
  `);
  console.log('\nTotal excess duplicates (Not Submitted):', totalDupes.rows[0].excess);

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
