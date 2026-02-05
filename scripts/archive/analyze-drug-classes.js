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
  {
    name: 'Statins',
    patterns: ['atorvastatin', 'rosuvastatin', 'simvastatin', 'pravastatin', 'lovastatin', 'fluvastatin', 'pitavastatin', 'lipitor', 'crestor', 'zocor', 'pravachol', 'mevacor', 'lescol', 'livalo', 'vytorin', 'liptruzet']
  },
  {
    name: 'ACE Inhibitors',
    patterns: ['lisinopril', 'enalapril', 'ramipril', 'benazepril', 'quinapril', 'fosinopril', 'captopril', 'trandolapril', 'perindopril', 'moexipril', 'zestril', 'prinivil', 'vasotec', 'altace', 'lotensin', 'accupril', 'monopril', 'capoten']
  },
  {
    name: 'ARBs',
    patterns: ['losartan', 'valsartan', 'irbesartan', 'olmesartan', 'telmisartan', 'candesartan', 'eprosartan', 'azilsartan', 'cozaar', 'diovan', 'avapro', 'benicar', 'micardis', 'atacand', 'teveten', 'edarbi', 'entresto']
  },
  {
    name: 'PPIs',
    patterns: ['omeprazole', 'esomeprazole', 'pantoprazole', 'lansoprazole', 'rabeprazole', 'dexlansoprazole', 'prilosec', 'nexium', 'protonix', 'prevacid', 'aciphex', 'dexilant']
  },
  {
    name: 'Beta Blockers',
    patterns: ['metoprolol', 'carvedilol', 'atenolol', 'bisoprolol', 'propranolol', 'nebivolol', 'labetalol', 'nadolol', 'sotalol', 'pindolol', 'acebutolol', 'betaxolol', 'toprol', 'coreg', 'tenormin', 'zebeta', 'inderal', 'bystolic']
  },
  {
    name: 'SSRIs',
    patterns: ['sertraline', 'escitalopram', 'fluoxetine', 'citalopram', 'paroxetine', 'fluvoxamine', 'vilazodone', 'vortioxetine', 'zoloft', 'lexapro', 'prozac', 'celexa', 'paxil', 'luvox', 'viibryd', 'trintellix']
  },
  {
    name: 'Oral Antidiabetics',
    patterns: ['metformin', 'glipizide', 'glimepiride', 'glyburide', 'pioglitazone', 'sitagliptin', 'linagliptin', 'saxagliptin', 'alogliptin', 'canagliflozin', 'dapagliflozin', 'empagliflozin', 'ertugliflozin', 'repaglinide', 'nateglinide', 'acarbose', 'glucophage', 'januvia', 'tradjenta', 'jardiance', 'farxiga', 'invokana', 'janumet', 'synjardy', 'xigduo']
  },
  {
    name: 'Thyroid Hormones',
    patterns: ['levothyroxine', 'liothyronine', 'liotrix', 'thyroid', 'synthroid', 'levoxyl', 'tirosint', 'unithroid', 'euthyrox', 'cytomel', 'armour thyroid', 'np thyroid', 'nature-throid', 'wp thyroid']
  },
  {
    name: 'Gabapentinoids',
    patterns: ['gabapentin', 'pregabalin', 'neurontin', 'lyrica', 'gralise', 'horizant']
  },
  {
    name: 'Calcium Channel Blockers',
    patterns: ['amlodipine', 'nifedipine', 'felodipine', 'nisoldipine', 'isradipine', 'nicardipine', 'clevidipine', 'norvasc', 'procardia', 'adalat', 'plendil', 'sular', 'cardene']
  }
];

async function analyzeDrugClasses() {
  console.log('Analyzing drug classes from prescription data...\n');

  const results = [];

  for (const drugClass of drugClasses) {
    // Build ILIKE pattern for SQL
    const likePatterns = drugClass.patterns.map((p, i) => `LOWER(drug_name) LIKE $${i + 1}`).join(' OR ');
    const params = drugClass.patterns.map(p => `%${p}%`);

    // Get reimbursement stats (total_paid = patient_pay + insurance_pay)
    const statsQuery = `
      SELECT
        COUNT(*) as total_claims,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as avg_reimbursement,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0))::numeric, 2) as avg_gross_profit,
        ROUND(SUM(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as total_reimbursement,
        ROUND(MIN(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as min_reimbursement,
        ROUND(MAX(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as max_reimbursement
      FROM prescriptions
      WHERE (${likePatterns})
        AND (COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0)) > 0
    `;

    const statsResult = await pool.query(statsQuery, params);
    const stats = statsResult.rows[0];

    // Get BIN/GROUP combinations with claim counts
    const binGroupQuery = `
      SELECT
        insurance_bin as bin,
        insurance_group as group_number,
        contract_id,
        plan_name,
        COUNT(*) as claim_count,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as avg_paid,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0))::numeric, 2) as avg_gp
      FROM prescriptions
      WHERE (${likePatterns})
        AND (COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0)) > 0
        AND insurance_bin IS NOT NULL
      GROUP BY insurance_bin, insurance_group, contract_id, plan_name
      ORDER BY claim_count DESC
      LIMIT 25
    `;

    const binGroupResult = await pool.query(binGroupQuery, params);

    // Get top drugs in this class
    const topDrugsQuery = `
      SELECT
        drug_name,
        COUNT(*) as claim_count,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0))::numeric, 2) as avg_paid,
        ROUND(AVG(COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0))::numeric, 2) as avg_gp
      FROM prescriptions
      WHERE (${likePatterns})
        AND (COALESCE(patient_pay, 0) + COALESCE(insurance_pay, 0)) > 0
      GROUP BY drug_name
      ORDER BY claim_count DESC
      LIMIT 10
    `;

    const topDrugsResult = await pool.query(topDrugsQuery, params);

    results.push({
      class_name: drugClass.name,
      stats: {
        total_claims: parseInt(stats.total_claims) || 0,
        avg_reimbursement: parseFloat(stats.avg_reimbursement) || 0,
        avg_gross_profit: parseFloat(stats.avg_gross_profit) || 0,
        total_reimbursement: parseFloat(stats.total_reimbursement) || 0,
        min_reimbursement: parseFloat(stats.min_reimbursement) || 0,
        max_reimbursement: parseFloat(stats.max_reimbursement) || 0
      },
      bin_groups: binGroupResult.rows.map(r => ({
        bin: r.bin,
        group: r.group_number || 'N/A',
        contract_id: r.contract_id || null,
        plan_name: r.plan_name || null,
        claims: parseInt(r.claim_count),
        avg_paid: parseFloat(r.avg_paid) || 0,
        avg_gp: parseFloat(r.avg_gp) || 0
      })),
      top_drugs: topDrugsResult.rows.map(r => ({
        drug_name: r.drug_name,
        claims: parseInt(r.claim_count),
        avg_paid: parseFloat(r.avg_paid) || 0,
        avg_gp: parseFloat(r.avg_gp) || 0
      }))
    });
  }

  // Sort by average gross profit descending
  results.sort((a, b) => b.stats.avg_gross_profit - a.stats.avg_gross_profit);

  // Print results
  console.log('=' .repeat(100));
  console.log('DRUG CLASS ANALYSIS - RANKED BY AVERAGE GROSS PROFIT');
  console.log('=' .repeat(100));
  console.log('');

  results.forEach((r, index) => {
    console.log(`\n${'#'.repeat(80)}`);
    console.log(`#${index + 1} - ${r.class_name.toUpperCase()}`);
    console.log(`${'#'.repeat(80)}`);
    console.log('');
    console.log('📊 REIMBURSEMENT STATS:');
    console.log(`   Total Claims: ${r.stats.total_claims.toLocaleString()}`);
    console.log(`   Avg Reimbursement: $${r.stats.avg_reimbursement.toFixed(2)}`);
    console.log(`   Avg Gross Profit: $${r.stats.avg_gross_profit.toFixed(2)}`);
    console.log(`   Total Reimbursement: $${r.stats.total_reimbursement.toLocaleString()}`);
    console.log(`   Range: $${r.stats.min_reimbursement.toFixed(2)} - $${r.stats.max_reimbursement.toFixed(2)}`);
    console.log('');

    if (r.top_drugs.length > 0) {
      console.log('💊 TOP DRUGS:');
      r.top_drugs.forEach(d => {
        console.log(`   ${d.drug_name}: ${d.claims} claims, avg paid $${d.avg_paid.toFixed(2)}, avg GP $${d.avg_gp.toFixed(2)}`);
      });
      console.log('');
    }

    if (r.bin_groups.length > 0) {
      console.log('🏦 BIN/GROUP/CONTRACT COMBINATIONS:');
      console.log('   ' + '-'.repeat(110));
      console.log(`   ${'BIN'.padEnd(10)} ${'GROUP'.padEnd(15)} ${'CONTRACT'.padEnd(12)} ${'PLAN'.padEnd(25)} ${'CLAIMS'.padStart(8)} ${'AVG PAID'.padStart(10)} ${'AVG GP'.padStart(10)}`);
      console.log('   ' + '-'.repeat(110));
      r.bin_groups.forEach(bg => {
        const planDisplay = (bg.plan_name || '').substring(0, 24);
        console.log(`   ${(bg.bin || 'N/A').padEnd(10)} ${(bg.group || 'N/A').padEnd(15)} ${(bg.contract_id || 'N/A').padEnd(12)} ${planDisplay.padEnd(25)} ${bg.claims.toString().padStart(8)} ${('$' + bg.avg_paid.toFixed(2)).padStart(10)} ${('$' + bg.avg_gp.toFixed(2)).padStart(10)}`);
      });
    }
  });

  // Save to JSON file
  const outputPath = './data/drug-class-analysis.json';
  fs.writeFileSync(outputPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    ranked_by: 'average_gross_profit',
    drug_classes: results
  }, null, 2));
  console.log(`\n\n✅ Results saved to ${outputPath}`);

  await pool.end();
}

analyzeDrugClasses().catch(console.error);
