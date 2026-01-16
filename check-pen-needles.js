import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Search for pen needles broadly
  const results = await pool.query(`
    SELECT drug_name, COUNT(*) as rx_count,
           AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, 0)) as avg_margin
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%PEN%' AND UPPER(drug_name) LIKE '%NEEDLE%'
    GROUP BY drug_name
    ORDER BY rx_count DESC
  `);

  console.log('All pen needle drugs in database:');
  results.rows.forEach(r => {
    console.log(`  ${r.drug_name}: ${r.rx_count} rxs, avg margin $${parseFloat(r.avg_margin || 0).toFixed(2)}`);
  });

  // Check rx 270338 specifically
  const specific = await pool.query(`
    SELECT rx_number, drug_name,
           COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, 0) as margin
    FROM prescriptions
    WHERE rx_number = '270338'
  `);

  console.log('\nRx 270338:');
  specific.rows.forEach(r => {
    console.log(`  ${r.drug_name}: margin $${parseFloat(r.margin || 0).toFixed(2)}`);
  });

  // Also check for GNP products
  const gnp = await pool.query(`
    SELECT drug_name, COUNT(*) as rx_count,
           AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, 0)) as avg_margin
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%GNP%'
    GROUP BY drug_name
    ORDER BY rx_count DESC
    LIMIT 20
  `);

  console.log('\nAll GNP products:');
  gnp.rows.forEach(r => {
    console.log(`  ${r.drug_name}: ${r.rx_count} rxs, avg margin $${parseFloat(r.avg_margin || 0).toFixed(2)}`);
  });

  await pool.end();
}

check().catch(console.error);
