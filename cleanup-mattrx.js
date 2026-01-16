import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function cleanup() {
  // Get MattRx pharmacy ID
  const pharmacy = await pool.query(`SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name = 'MattRx'`);
  const pharmacyId = pharmacy.rows[0].pharmacy_id;
  console.log('MattRx pharmacy ID:', pharmacyId);

  // Delete all MattRx opportunities
  const deleted = await pool.query(`
    DELETE FROM opportunities WHERE pharmacy_id = $1 RETURNING opportunity_id
  `, [pharmacyId]);
  console.log(`Deleted ${deleted.rows.length} opportunities`);

  await pool.end();
}

cleanup().catch(console.error);
