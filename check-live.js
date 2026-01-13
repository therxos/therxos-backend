import pg from 'pg';

// Use the direct Supabase connection from .env.local
const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const pharmacyId = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'; // Bravo

  console.log('=== LIVE DATABASE CHECK ===\n');

  const stats = await pool.query(`
    SELECT status, COUNT(*) as count, SUM(potential_margin_gain) as total_value
    FROM opportunities WHERE pharmacy_id = $1
    GROUP BY status ORDER BY count DESC
  `, [pharmacyId]);

  stats.rows.forEach(r => console.log(`${r.status}: ${r.count} ($${parseFloat(r.total_value||0).toFixed(2)})`));

  const total = await pool.query('SELECT COUNT(*) as total FROM opportunities WHERE pharmacy_id = $1', [pharmacyId]);
  console.log(`\nTOTAL: ${total.rows[0].total}`);

  // Captured = Approved + Completed
  const captured = stats.rows
    .filter(r => r.status === 'Approved' || r.status === 'Completed')
    .reduce((sum, r) => sum + parseInt(r.count), 0);
  console.log(`CAPTURED (Approved+Completed): ${captured}`);

  const submitted = stats.rows.find(r => r.status === 'Submitted');
  console.log(`SUBMITTED: ${submitted?.count || 0}`);

  await pool.end();
}

check().catch(console.error);
