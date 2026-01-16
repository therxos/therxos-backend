import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // MattRx stats
  const stats = await pool.query(`
    SELECT
      COUNT(*) as total_opps,
      SUM(potential_margin_gain) as total_margin,
      COUNT(*) FILTER (WHERE current_drug_name IS NULL OR current_drug_name = '') as missing_drug,
      COUNT(DISTINCT patient_id) as unique_patients
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    WHERE p.pharmacy_name = 'MattRx'
  `);
  console.log('MattRx Stats:', stats.rows[0]);

  // Check prescriptions with days_supply
  const ds = await pool.query(`
    SELECT days_supply, COUNT(*) as count, AVG(COALESCE((raw_data->>'gross_profit')::numeric, 0)) as avg_gp
    FROM prescriptions pr
    JOIN pharmacies p ON p.pharmacy_id = pr.pharmacy_id
    WHERE p.pharmacy_name = 'MattRx'
    GROUP BY days_supply
    ORDER BY count DESC
    LIMIT 10
  `);
  console.log('\nDays Supply breakdown:');
  ds.rows.forEach(r => console.log(`  ${r.days_supply} days: ${r.count} rxs, avg GP: $${parseFloat(r.avg_gp || 0).toFixed(2)}`));

  // Sample opps without current_drug_name
  const missing = await pool.query(`
    SELECT o.opportunity_id, o.recommended_drug_name, o.current_drug_name, pr.drug_name as rx_drug
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    WHERE p.pharmacy_name = 'MattRx' AND (o.current_drug_name IS NULL OR o.current_drug_name = '')
    LIMIT 5
  `);
  console.log('\nSample opps missing current_drug:');
  missing.rows.forEach(r => console.log(`  Recommended: ${r.recommended_drug_name}, Current: ${r.current_drug_name}, Rx Drug: ${r.rx_drug}`));

  // Check what triggers are firing most
  const triggers = await pool.query(`
    SELECT recommended_drug_name, COUNT(*) as count
    FROM opportunities o
    JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
    WHERE p.pharmacy_name = 'MattRx'
    GROUP BY recommended_drug_name
    ORDER BY count DESC
    LIMIT 10
  `);
  console.log('\nTop triggers by opp count:');
  triggers.rows.forEach(r => console.log(`  ${r.recommended_drug_name}: ${r.count}`));

  await pool.end();
}

check().catch(console.error);
