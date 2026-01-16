import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const results = await pool.query(`
    SELECT display_name, detection_keywords, trigger_type, is_enabled
    FROM triggers
    WHERE UPPER(display_name) LIKE '%INSULIN%'
       OR UPPER(display_name) LIKE '%SYRINGE%'
       OR UPPER(display_name) LIKE '%NEEDLE%'
       OR UPPER(display_name) LIKE '%GLUCAGON%'
       OR UPPER(display_name) LIKE '%LANCET%'
       OR EXISTS (
         SELECT 1 FROM unnest(detection_keywords) kw
         WHERE UPPER(kw) LIKE '%INSULIN%'
       )
    ORDER BY display_name
  `);

  console.log('Insulin-related triggers:');
  console.log('=========================\n');
  results.rows.forEach(r => {
    const status = r.is_enabled ? '[ON] ' : '[OFF]';
    console.log(`${status} ${r.display_name}`);
    console.log(`      Type: ${r.trigger_type}`);
    console.log(`      Detection: ${(r.detection_keywords || []).join(', ')}`);
    console.log('');
  });

  await pool.end();
}

check().catch(console.error);
