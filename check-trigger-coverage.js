import pg from 'pg';

const pool = new pg.Pool({
  connectionString: 'postgresql://postgres:rX%40pharmacystan@db.vjqkgkpfkpdmfajiprkp.supabase.co:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

const triggerNames = [
  'Abilify',
  'Lamotrigine ODT',
  'Dorzolamide-Timolol',
  'Ezetimibe',
  'Verifine',
  'Pure Comfort',
  'Alcohol Swabs',
  'Insulin Syringes',
  'Glucagon',
  'Advair',
  'Ramelteon',
  'Droplet',
  'GNP Pen Needles'
];

async function check() {
  // Get all triggers with their recommended drugs
  const triggers = await pool.query(`
    SELECT trigger_id, display_name, recommended_drug, recommended_ndc, trigger_type
    FROM triggers
    WHERE is_enabled = true
    ORDER BY display_name
  `);

  console.log('=== CHECKING TRIGGERS WITHOUT COVERAGE MATCHES ===\n');

  for (const t of triggers.rows) {
    // Check if this trigger name matches any of our problem triggers
    const isTarget = triggerNames.some(n => t.display_name.toUpperCase().includes(n.toUpperCase()));
    if (!isTarget) continue;

    const drug = t.recommended_drug || '';
    const ndc = t.recommended_ndc || '';

    console.log(`\n--- ${t.display_name} ---`);
    console.log(`Recommended: ${drug || '(none)'}`);
    console.log(`NDC: ${ndc || '(none)'}`);
    console.log(`Type: ${t.trigger_type}`);

    if (!drug && !ndc) {
      console.log('⚠️  No recommended drug or NDC set!');
      continue;
    }

    // Search for any prescriptions matching this drug
    if (drug) {
      const words = drug.split(/[\s,.\-\(\)]+/).filter(w => w.length >= 3 && !/^\d+$/.test(w));
      if (words.length === 0) {
        console.log('⚠️  No searchable words in recommended drug');
        continue;
      }

      const conditions = words.map((w, i) => `UPPER(drug_name) LIKE '%' || $${i+1} || '%'`);
      const query = `
        SELECT drug_name,
               COUNT(*) as rx_count,
               AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, 0)) as avg_margin,
               MIN(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, 0)) as min_margin,
               MAX(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, 0)) as max_margin
        FROM prescriptions
        WHERE ${conditions.join(' AND ')}
        GROUP BY drug_name
        ORDER BY rx_count DESC
        LIMIT 5
      `;
      const params = words.map(w => w.toUpperCase());

      const results = await pool.query(query, params);

      if (results.rows.length === 0) {
        console.log('❌ No matching prescriptions found in database');
      } else {
        console.log(`✓ Found ${results.rows.length} matching drug(s):`);
        results.rows.forEach(r => {
          const avg = parseFloat(r.avg_margin || 0).toFixed(2);
          const min = parseFloat(r.min_margin || 0).toFixed(2);
          const max = parseFloat(r.max_margin || 0).toFixed(2);
          console.log(`   ${r.drug_name}: ${r.rx_count} rxs, margin $${min} to $${max} (avg $${avg})`);
        });
      }
    } else if (ndc) {
      const query = `
        SELECT drug_name,
               COUNT(*) as rx_count,
               AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, 0)) as avg_margin
        FROM prescriptions
        WHERE ndc = $1
        GROUP BY drug_name
        LIMIT 5
      `;

      const results = await pool.query(query, [ndc]);

      if (results.rows.length === 0) {
        console.log('❌ No matching prescriptions found in database');
      } else {
        console.log(`✓ Found ${results.rows.length} matching drug(s):`);
        results.rows.forEach(r => {
          const avg = parseFloat(r.avg_margin || 0).toFixed(2);
          console.log(`   ${r.drug_name}: ${r.rx_count} rxs, avg margin $${avg}`);
        });
      }
    }
  }

  await pool.end();
}

check().catch(console.error);
