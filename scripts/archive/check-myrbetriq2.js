import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Get the trigger details
  const trigger = await pool.query(`
    SELECT trigger_id, display_name, trigger_type, detection_keywords, exclude_keywords,
           if_has_keywords, if_not_has_keywords, recommended_drug, recommended_ndc,
           default_gp_value, is_enabled, keyword_match_mode,
           bin_inclusions, bin_exclusions, group_inclusions, group_exclusions
    FROM triggers
    WHERE LOWER(display_name) LIKE '%myrbetriq%' OR LOWER(display_name) LIKE '%mirabegron%'
  `);
  console.log('Trigger:');
  trigger.rows.forEach(t => {
    console.log(`  Name: ${t.display_name}`);
    console.log(`  Enabled: ${t.is_enabled}`);
    console.log(`  Type: ${t.trigger_type}`);
    console.log(`  Match mode: ${t.keyword_match_mode}`);
    console.log(`  Detection: ${JSON.stringify(t.detection_keywords)}`);
    console.log(`  Exclude: ${JSON.stringify(t.exclude_keywords)}`);
    console.log(`  If has: ${JSON.stringify(t.if_has_keywords)}`);
    console.log(`  If not has: ${JSON.stringify(t.if_not_has_keywords)}`);
    console.log(`  Recommended: ${t.recommended_drug}`);
    console.log(`  Default GP: $${t.default_gp_value}`);
    console.log(`  BIN inclusions: ${JSON.stringify(t.bin_inclusions)}`);
    console.log(`  BIN exclusions: ${JSON.stringify(t.bin_exclusions)}`);
  });

  // Check for Myrbetriq prescriptions
  const rxs = await pool.query(`
    SELECT drug_name, COUNT(*) as cnt,
           array_agg(DISTINCT insurance_bin) as bins,
           array_agg(DISTINCT days_supply::text) as days_supplies
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%MYRBETRIQ%' OR UPPER(drug_name) LIKE '%MIRABEGRON%'
    GROUP BY drug_name
    ORDER BY cnt DESC
  `);
  console.log('\nMyrbetriq/Mirabegron prescriptions:');
  rxs.rows.forEach(r => console.log(`  "${r.drug_name}": ${r.cnt} claims, BINs: ${r.bins}, days_supply: ${r.days_supplies}`));

  // Check existing opportunities
  const opps = await pool.query(`
    SELECT COUNT(*) as cnt, status
    FROM opportunities
    WHERE LOWER(current_drug_name) LIKE '%myrbetriq%' OR LOWER(recommended_drug_name) LIKE '%mirabegron%'
    GROUP BY status
  `);
  console.log('\nExisting Myrbetriq opps:');
  opps.rows.forEach(r => console.log(`  ${r.status}: ${r.cnt}`));

  // Test the matching - simulate what scanner does
  if (trigger.rows.length > 0) {
    const t = trigger.rows[0];
    const keywords = t.detection_keywords || [];
    const excludeKw = t.exclude_keywords || [];

    // Get sample prescriptions and test matching
    const samples = await pool.query(`
      SELECT prescription_id, drug_name, insurance_bin, days_supply, patient_id
      FROM prescriptions
      WHERE UPPER(drug_name) LIKE '%MYRBETRIQ%' OR UPPER(drug_name) LIKE '%MIRABEGRON%'
      LIMIT 5
    `);

    console.log('\nMatching test:');
    for (const rx of samples.rows) {
      const drugUpper = (rx.drug_name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ');
      const matchMode = t.keyword_match_mode || 'any';

      const matchesDetect = matchMode === 'all'
        ? keywords.every(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
        : keywords.some(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')));

      const matchesExclude = excludeKw.some(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')));

      console.log(`  "${rx.drug_name}" → normalized: "${drugUpper}"`);
      console.log(`    Detection (${matchMode}): ${matchesDetect} | Keywords: ${JSON.stringify(keywords)}`);
      console.log(`    Excluded: ${matchesExclude} | Exclude kw: ${JSON.stringify(excludeKw)}`);
      console.log(`    BIN: ${rx.insurance_bin}`);
    }
  }

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
