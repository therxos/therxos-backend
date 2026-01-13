import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  console.log('=== ALL PHARMACIES ===\n');

  const pharmacies = await pool.query(`
    SELECT p.pharmacy_id, p.pharmacy_name,
           COUNT(o.opportunity_id) as opp_count,
           SUM(CASE WHEN o.status = 'Submitted' THEN 1 ELSE 0 END) as submitted,
           SUM(CASE WHEN o.status IN ('Approved', 'Completed') THEN 1 ELSE 0 END) as captured
    FROM pharmacies p
    LEFT JOIN opportunities o ON o.pharmacy_id = p.pharmacy_id
    GROUP BY p.pharmacy_id, p.pharmacy_name
    ORDER BY opp_count DESC
  `);

  pharmacies.rows.forEach(r => {
    console.log(`${r.pharmacy_name}: ${r.opp_count} total, ${r.submitted} submitted, ${r.captured} captured`);
    console.log(`  ID: ${r.pharmacy_id}\n`);
  });

  // Check if there's a user with different pharmacy assignment
  console.log('=== BRAVO USERS ===\n');
  const users = await pool.query(`
    SELECT u.email, u.pharmacy_id, p.pharmacy_name
    FROM users u
    LEFT JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id
    WHERE p.pharmacy_name ILIKE '%bravo%' OR u.pharmacy_id = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'
  `);
  users.rows.forEach(r => console.log(`${r.email} -> ${r.pharmacy_name} (${r.pharmacy_id})`));

  await pool.end();
}

check().catch(console.error);
