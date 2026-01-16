import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Find diclofenac trigger
  console.log('=== DICLOFENAC TRIGGERS ===\n');
  const triggers = await pool.query(`
    SELECT t.trigger_id, t.display_name, t.recommended_drug, t.default_gp_value, t.is_enabled
    FROM triggers t
    WHERE LOWER(t.display_name) LIKE '%diclofenac%'
       OR LOWER(t.recommended_drug) LIKE '%diclofenac%'
  `);

  for (const t of triggers.rows) {
    console.log(`Trigger: ${t.display_name}`);
    console.log(`  Recommended: ${t.recommended_drug}`);
    console.log(`  Default GP: $${t.default_gp_value}`);
    console.log(`  Enabled: ${t.is_enabled}`);

    // Get BIN values
    const bins = await pool.query(`
      SELECT insurance_bin, insurance_group, gp_value, coverage_status
      FROM trigger_bin_values
      WHERE trigger_id = $1
      ORDER BY gp_value DESC
    `, [t.trigger_id]);

    console.log(`  BIN Values:`);
    bins.rows.forEach(b => {
      console.log(`    ${b.insurance_bin} / ${b.insurance_group || '(all)'}: $${b.gp_value} [${b.coverage_status}]`);
    });
    console.log('');
  }

  // Find the high-value diclofenac opportunities on 003858/2FGA
  console.log('=== HIGH VALUE DICLOFENAC OPPS ON 003858/2FGA ===\n');
  const opps = await pool.query(`
    SELECT o.opportunity_id, o.recommended_drug_name, o.potential_margin_gain, o.status,
           p.primary_insurance_bin, p.primary_insurance_group
    FROM opportunities o
    JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.pharmacy_id = 'bd8e10ee-dbef-4b81-b2fa-3ff2a9269518'
      AND LOWER(o.recommended_drug_name) LIKE '%diclofenac%'
      AND p.primary_insurance_bin = '003858'
    ORDER BY o.potential_margin_gain DESC
    LIMIT 20
  `);

  opps.rows.forEach(o => {
    console.log(`$${o.potential_margin_gain} - ${o.recommended_drug_name} - ${o.primary_insurance_bin}/${o.primary_insurance_group} [${o.status}]`);
    console.log(`  ID: ${o.opportunity_id}`);
  });

  await pool.end();
}

check().catch(console.error);
