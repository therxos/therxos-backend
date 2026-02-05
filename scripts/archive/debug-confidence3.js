import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const bravoId = (await pool.query("SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%' LIMIT 1")).rows[0].pharmacy_id;

  // Simulate the actual query for ESC,GLO
  const p1 = await pool.query(`
    SELECT o.recommended_drug_name, o.trigger_id,
      COALESCE(pr.insurance_bin, p.primary_insurance_bin, '') as insurance_bin,
      COALESCE(pr.insurance_group, p.primary_insurance_group, '') as insurance_group,
      CASE
        WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
        WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
        WHEN tbv.verified_claim_count > 0 THEN 'verified'
        WHEN tbv_bin.coverage_status IN ('verified', 'works') THEN 'likely'
        WHEN tbv_bin.verified_claim_count > 0 THEN 'likely'
        ELSE 'unknown'
      END as coverage_confidence,
      tbv.insurance_bin as tbv_match_bin,
      tbv.insurance_group as tbv_match_grp,
      tbv.coverage_status as tbv_status,
      tbv_bin.insurance_bin as tbv_bin_match,
      tbv_bin.coverage_status as tbv_bin_status
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
      AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
    LEFT JOIN trigger_bin_values tbv_bin ON tbv_bin.trigger_id = o.trigger_id
      AND tbv_bin.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND tbv_bin.insurance_group IS NULL
      AND tbv.trigger_id IS NULL
    WHERE p.last_name ILIKE 'ESC%' AND p.first_name ILIKE 'GLO%'
      AND p.date_of_birth = '1942-06-25'
      AND o.pharmacy_id = $1
    ORDER BY o.recommended_drug_name
  `, [bravoId]);

  console.log('=== ESC,GLO after backfill ===');
  for (const r of p1.rows) {
    console.log(`  ${r.recommended_drug_name} -> ${r.coverage_confidence}`);
    console.log(`    trigger_id: ${r.trigger_id || 'NULL'} | BIN: ${r.insurance_bin} | GRP: ${r.insurance_group}`);
    console.log(`    tbv exact: bin=${r.tbv_match_bin || 'NONE'} grp=${r.tbv_match_grp || 'NONE'} status=${r.tbv_status || 'NONE'}`);
    console.log(`    tbv BIN-only: bin=${r.tbv_bin_match || 'NONE'} status=${r.tbv_bin_status || 'NONE'}`);
  }

  // COL,NOE
  const p2 = await pool.query(`
    SELECT o.recommended_drug_name, o.trigger_id,
      COALESCE(pr.insurance_bin, p.primary_insurance_bin, '') as insurance_bin,
      COALESCE(pr.insurance_group, p.primary_insurance_group, '') as insurance_group,
      CASE
        WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
        WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
        WHEN tbv.verified_claim_count > 0 THEN 'verified'
        WHEN tbv_bin.coverage_status IN ('verified', 'works') THEN 'likely'
        WHEN tbv_bin.verified_claim_count > 0 THEN 'likely'
        ELSE 'unknown'
      END as coverage_confidence,
      tbv.insurance_bin as tbv_match_bin,
      tbv.insurance_group as tbv_match_grp,
      tbv.coverage_status as tbv_status,
      tbv_bin.insurance_bin as tbv_bin_match,
      tbv_bin.coverage_status as tbv_bin_status
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
      AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
    LEFT JOIN trigger_bin_values tbv_bin ON tbv_bin.trigger_id = o.trigger_id
      AND tbv_bin.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND tbv_bin.insurance_group IS NULL
      AND tbv.trigger_id IS NULL
    WHERE p.last_name ILIKE 'COL%' AND p.first_name ILIKE 'NOE%'
      AND p.date_of_birth = '1954-04-05'
      AND o.pharmacy_id = $1
    ORDER BY o.recommended_drug_name
  `, [bravoId]);

  console.log('\n=== COL,NOE after backfill ===');
  for (const r of p2.rows) {
    console.log(`  ${r.recommended_drug_name} -> ${r.coverage_confidence}`);
    console.log(`    trigger_id: ${r.trigger_id || 'NULL'} | BIN: ${r.insurance_bin} | GRP: ${r.insurance_group}`);
    if (r.trigger_id) {
      console.log(`    tbv exact: bin=${r.tbv_match_bin || 'NONE'} grp=${r.tbv_match_grp || 'NONE'} status=${r.tbv_status || 'NONE'}`);
      console.log(`    tbv BIN-only: bin=${r.tbv_bin_match || 'NONE'} status=${r.tbv_bin_status || 'NONE'}`);
    }
  }

  // Quick summary of Bravo confidence distribution
  const dist = await pool.query(`
    SELECT
      CASE
        WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
        WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
        WHEN tbv.verified_claim_count > 0 THEN 'verified'
        WHEN tbv_bin.coverage_status IN ('verified', 'works') THEN 'likely'
        WHEN tbv_bin.verified_claim_count > 0 THEN 'likely'
        ELSE 'unknown'
      END as confidence,
      COUNT(*) as cnt
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
      AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
    LEFT JOIN trigger_bin_values tbv_bin ON tbv_bin.trigger_id = o.trigger_id
      AND tbv_bin.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND tbv_bin.insurance_group IS NULL
      AND tbv.trigger_id IS NULL
    WHERE o.pharmacy_id = $1
    GROUP BY confidence
    ORDER BY cnt DESC
  `, [bravoId]);

  console.log('\n=== Bravo confidence distribution ===');
  for (const r of dist.rows) {
    console.log(`  ${r.confidence}: ${r.cnt}`);
  }

  await pool.end();
}
run();
