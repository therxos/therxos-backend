import pg from 'pg';

// Pooler connection from .env
const pool = new pg.Pool({
  connectionString: 'postgresql://postgres.vjqkgkpfkpdmfajiprkp:rX%40pharmacystan@aws-0-us-west-2.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const pharmacyId = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518';

  console.log('=== POOLER CONNECTION ===\n');

  const stats = await pool.query(`
    SELECT status, COUNT(*) as count FROM opportunities WHERE pharmacy_id = $1 GROUP BY status ORDER BY count DESC
  `, [pharmacyId]);
  stats.rows.forEach(r => console.log(`${r.status}: ${r.count}`));

  const total = await pool.query('SELECT COUNT(*) as total FROM opportunities WHERE pharmacy_id = $1', [pharmacyId]);
  console.log(`\nTOTAL: ${total.rows[0].total}`);

  await pool.end();
}

check().catch(console.error);
