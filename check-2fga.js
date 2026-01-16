import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Find opportunities with 003858/2FGA
  console.log('=== OPPORTUNITIES WITH 003858/2FGA ===\n');
  const opps = await pool.query(`
    SELECT o.opportunity_id, o.recommended_drug_name, o.potential_margin_gain, o.status,
           p.primary_insurance_bin, p.primary_insurance_group,
           pr.insurance_bin, pr.insurance_group
    FROM opportunities o
    JOIN patients p ON p.patient_id = o.patient_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    WHERE o.pharmacy_id = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'
      AND (p.primary_insurance_group = '2FGA' OR pr.insurance_group = '2FGA')
    ORDER BY o.potential_margin_gain DESC
    LIMIT 30
  `);

  console.log(`Found ${opps.rows.length} opportunities with 2FGA group:\n`);
  opps.rows.forEach(o => {
    console.log(`$${o.potential_margin_gain} - ${o.recommended_drug_name}`);
    console.log(`  Patient: ${o.primary_insurance_bin}/${o.primary_insurance_group}`);
    console.log(`  Rx: ${o.insurance_bin}/${o.insurance_group}`);
    console.log(`  Status: ${o.status}`);
    console.log(`  ID: ${o.opportunity_id}\n`);
  });

  // Check what BIN/Groups are on diclofenac opps
  console.log('=== ALL DICLOFENAC OPPS BY BIN/GROUP ===\n');
  const diclo = await pool.query(`
    SELECT p.primary_insurance_bin as bin, p.primary_insurance_group as grp,
           COUNT(*) as count, AVG(o.potential_margin_gain) as avg_gp
    FROM opportunities o
    JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.pharmacy_id = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'
      AND LOWER(o.recommended_drug_name) LIKE '%diclofenac%'
    GROUP BY p.primary_insurance_bin, p.primary_insurance_group
    ORDER BY avg_gp DESC
  `);

  diclo.rows.forEach(r => {
    console.log(`${r.bin}/${r.grp}: ${r.count} opps, avg $${parseFloat(r.avg_gp).toFixed(2)}`);
  });

  await pool.end();
}

check().catch(console.error);
