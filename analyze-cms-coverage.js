import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Drug class patterns for matching
const drugClasses = [
  { name: 'ARBs', patterns: ['losartan', 'valsartan', 'irbesartan', 'olmesartan', 'telmisartan', 'candesartan', 'azilsartan', 'entresto', 'sacubitril'] },
  { name: 'PPIs', patterns: ['omeprazole', 'esomeprazole', 'pantoprazole', 'lansoprazole', 'rabeprazole', 'dexlansoprazole'] },
  { name: 'Thyroid', patterns: ['levothyroxine', 'synthroid', 'liothyronine', 'armour thyroid', 'np thyroid'] },
  { name: 'Antidiabetics', patterns: ['metformin', 'glipizide', 'glimepiride', 'januvia', 'jardiance', 'farxiga', 'invokana', 'ozempic', 'trulicity', 'mounjaro'] },
  { name: 'SSRIs', patterns: ['sertraline', 'escitalopram', 'fluoxetine', 'citalopram', 'paroxetine'] },
  { name: 'ACE Inhibitors', patterns: ['lisinopril', 'enalapril', 'ramipril', 'benazepril', 'quinapril', 'fosinopril'] },
  { name: 'Statins', patterns: ['atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'lovastatin'] },
  { name: 'Beta Blockers', patterns: ['metoprolol', 'carvedilol', 'atenolol', 'bisoprolol', 'propranolol', 'nebivolol'] },
  { name: 'Gabapentinoids', patterns: ['gabapentin', 'pregabalin', 'lyrica', 'neurontin'] },
  { name: 'CCBs', patterns: ['amlodipine', 'nifedipine', 'felodipine', 'diltiazem', 'verapamil'] }
];

async function analyzeCMSCoverage() {
  console.log('Analyzing CMS Medicare Part D formulary data...\n');

  // First get the structure of cms_coverage_lookup
  const lookupCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'cms_coverage_lookup'
    ORDER BY ordinal_position
  `);
  console.log('cms_coverage_lookup columns:', lookupCheck.rows.map(r => r.column_name).join(', '));

  // Check what contracts we have claims for
  const contractsWithClaims = await pool.query(`
    SELECT DISTINCT contract_id, plan_name, insurance_bin, insurance_group
    FROM prescriptions
    WHERE contract_id IS NOT NULL
    ORDER BY contract_id
    LIMIT 50
  `);
  console.log('\nContracts in claims data:');
  contractsWithClaims.rows.forEach(r => {
    console.log(`  ${r.contract_id} | BIN: ${r.insurance_bin} | Group: ${r.insurance_group} | ${r.plan_name || 'N/A'}`);
  });

  // Get formulary IDs associated with contracts from cms_plan_formulary
  const planFormularyCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'cms_plan_formulary'
    ORDER BY ordinal_position
  `);
  console.log('\n\ncms_plan_formulary columns:', planFormularyCheck.rows.map(r => r.column_name).join(', '));

  const planFormularies = await pool.query(`
    SELECT * FROM cms_plan_formulary LIMIT 10
  `);
  console.log('\nSample plan formulary data:');
  planFormularies.rows.forEach(r => console.log(r));

  // Now analyze coverage for each drug class
  console.log('\n\n' + '='.repeat(120));
  console.log('CMS FORMULARY COVERAGE BY DRUG CLASS');
  console.log('='.repeat(120));

  for (const drugClass of drugClasses) {
    console.log(`\n${'#'.repeat(100)}`);
    console.log(`${drugClass.name.toUpperCase()}`);
    console.log(`${'#'.repeat(100)}`);

    // Build pattern matching for drug names in CMS data
    // CMS uses RXCUI - we need to match by looking up NDCs that match our drug patterns
    // First let's check what data format CMS uses

    // Get coverage stats from cms_formulary_drugs
    const likePatterns = drugClass.patterns.map((p, i) => `LOWER(drug_name) LIKE $${i + 1}`).join(' OR ');
    const params = drugClass.patterns.map(p => `%${p}%`);

    // Get prescriptions with these drugs that have contract IDs
    const rxWithContracts = await pool.query(`
      SELECT DISTINCT
        p.contract_id,
        p.plan_name,
        p.insurance_bin,
        p.insurance_group,
        p.drug_name,
        p.ndc,
        COUNT(*) as claim_count,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0))::numeric, 2) as avg_gp
      FROM prescriptions p
      WHERE (${likePatterns})
        AND p.contract_id IS NOT NULL
      GROUP BY p.contract_id, p.plan_name, p.insurance_bin, p.insurance_group, p.drug_name, p.ndc
      ORDER BY claim_count DESC
      LIMIT 30
    `, params);

    if (rxWithContracts.rows.length === 0) {
      console.log('  No claims with contract IDs found for this drug class');
      continue;
    }

    console.log(`\n📋 Claims with Contract IDs (${rxWithContracts.rows.length} drug/contract combos):`);
    console.log('   ' + '-'.repeat(115));
    console.log(`   ${'CONTRACT'.padEnd(12)} ${'BIN'.padEnd(8)} ${'GROUP'.padEnd(12)} ${'DRUG'.padEnd(35)} ${'NDC'.padEnd(14)} ${'CLAIMS'.padStart(7)} ${'AVG GP'.padStart(10)}`);
    console.log('   ' + '-'.repeat(115));

    for (const row of rxWithContracts.rows.slice(0, 15)) {
      const drugShort = (row.drug_name || '').substring(0, 33);
      console.log(`   ${(row.contract_id || 'N/A').padEnd(12)} ${(row.insurance_bin || 'N/A').padEnd(8)} ${(row.insurance_group || 'N/A').padEnd(12)} ${drugShort.padEnd(35)} ${(row.ndc || 'N/A').padEnd(14)} ${row.claim_count.toString().padStart(7)} ${('$' + row.avg_gp).padStart(10)}`);
    }

    // Now look up CMS formulary data for these NDCs
    const ndcs = rxWithContracts.rows.map(r => r.ndc).filter(Boolean);
    if (ndcs.length > 0) {
      // Get unique formulary data for these NDCs
      const cmsData = await pool.query(`
        SELECT
          ndc,
          formulary_id,
          tier_level,
          prior_authorization_yn as pa,
          step_therapy_yn as st,
          quantity_limit_yn as ql,
          quantity_limit_amount,
          quantity_limit_days
        FROM cms_formulary_drugs
        WHERE ndc = ANY($1)
        ORDER BY ndc, formulary_id
      `, [ndcs]);

      if (cmsData.rows.length > 0) {
        console.log(`\n🏥 CMS Formulary Data (${cmsData.rows.length} entries):`);
        console.log('   ' + '-'.repeat(100));
        console.log(`   ${'NDC'.padEnd(14)} ${'FORMULARY'.padEnd(12)} ${'TIER'.padStart(5)} ${'PA'.padStart(4)} ${'ST'.padStart(4)} ${'QL'.padStart(4)} ${'QL AMT'.padStart(8)} ${'QL DAYS'.padStart(8)}`);
        console.log('   ' + '-'.repeat(100));

        // Show unique by NDC
        const seenNdcs = new Set();
        for (const row of cmsData.rows) {
          if (seenNdcs.has(row.ndc)) continue;
          seenNdcs.add(row.ndc);
          console.log(`   ${(row.ndc || 'N/A').padEnd(14)} ${(row.formulary_id || 'N/A').padEnd(12)} ${(row.tier_level?.toString() || '-').padStart(5)} ${(row.pa ? 'YES' : 'NO').padStart(4)} ${(row.st ? 'YES' : 'NO').padStart(4)} ${(row.ql ? 'YES' : 'NO').padStart(4)} ${(row.quantity_limit_amount?.toString() || '-').padStart(8)} ${(row.quantity_limit_days?.toString() || '-').padStart(8)}`);
          if (seenNdcs.size >= 20) break;
        }

        // Summary stats
        const paCount = cmsData.rows.filter(r => r.pa).length;
        const stCount = cmsData.rows.filter(r => r.st).length;
        const qlCount = cmsData.rows.filter(r => r.ql).length;
        console.log(`\n   📊 Summary: ${paCount}/${cmsData.rows.length} require PA, ${stCount}/${cmsData.rows.length} require ST, ${qlCount}/${cmsData.rows.length} have QL`);
      }
    }
  }

  // Also show which contracts we have CMS data for
  console.log('\n\n' + '='.repeat(120));
  console.log('CONTRACT/FORMULARY MAPPING');
  console.log('='.repeat(120));

  const formularyMapping = await pool.query(`
    SELECT
      cpf.contract_id,
      cpf.pbp_id,
      cpf.plan_name,
      cpf.formulary_id,
      COUNT(DISTINCT cfd.ndc) as drug_count
    FROM cms_plan_formulary cpf
    LEFT JOIN cms_formulary_drugs cfd ON cpf.formulary_id = cfd.formulary_id
    GROUP BY cpf.contract_id, cpf.pbp_id, cpf.plan_name, cpf.formulary_id
    ORDER BY drug_count DESC
    LIMIT 30
  `);

  console.log('\nTop 30 Contracts with CMS Formulary Data:');
  console.log('-'.repeat(100));
  console.log(`${'CONTRACT'.padEnd(12)} ${'PBP'.padEnd(6)} ${'FORMULARY'.padEnd(12)} ${'DRUGS'.padStart(8)} ${'PLAN NAME'}`);
  console.log('-'.repeat(100));
  for (const row of formularyMapping.rows) {
    console.log(`${(row.contract_id || 'N/A').padEnd(12)} ${(row.pbp_id || 'N/A').padEnd(6)} ${(row.formulary_id || 'N/A').padEnd(12)} ${row.drug_count.toString().padStart(8)} ${(row.plan_name || '').substring(0, 50)}`);
  }

  await pool.end();
  console.log('\n\nDone!');
}

analyzeCMSCoverage().catch(console.error);
