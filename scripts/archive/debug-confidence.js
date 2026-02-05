import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  const bravoId = (await pool.query("SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%' LIMIT 1")).rows[0].pharmacy_id;
  console.log('Bravo pharmacy_id:', bravoId);

  // Patient ESC,GLO DOB 06/25/1942
  const p1 = await pool.query(`
    SELECT o.opportunity_id, o.trigger_id, o.recommended_drug_name, o.opportunity_type,
      COALESCE(pr.insurance_bin, p.primary_insurance_bin) as bin,
      COALESCE(pr.insurance_group, p.primary_insurance_group) as grp,
      o.prescription_id,
      pr.insurance_bin as rx_bin, pr.insurance_group as rx_grp,
      p.primary_insurance_bin as pat_bin, p.primary_insurance_group as pat_grp
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    WHERE p.last_name ILIKE 'ESC%' AND p.first_name ILIKE 'GLO%'
      AND p.date_of_birth = '1942-06-25'
      AND o.pharmacy_id = $1
    ORDER BY o.recommended_drug_name
  `, [bravoId]);

  console.log('\n=== Patient ESC,GLO (DOB 06/25/1942) ===');
  for (const r of p1.rows) {
    console.log(`  ${r.recommended_drug_name}`);
    console.log(`    trigger_id: ${r.trigger_id || 'NULL'}`);
    console.log(`    BIN: ${r.bin} | GRP: ${r.grp}`);
    console.log(`    rx_bin: ${r.rx_bin} | rx_grp: ${r.rx_grp} | pat_bin: ${r.pat_bin} | pat_grp: ${r.pat_grp}`);
    console.log(`    prescription_id: ${r.prescription_id || 'NULL'}`);

    // Check trigger_bin_values for this trigger
    if (r.trigger_id) {
      const tbv = await pool.query(`
        SELECT insurance_bin, insurance_group, coverage_status, is_excluded, verified_claim_count
        FROM trigger_bin_values
        WHERE trigger_id = $1
        ORDER BY insurance_bin, insurance_group
      `, [r.trigger_id]);
      console.log(`    trigger_bin_values (${tbv.rowCount} entries):`);
      for (const b of tbv.rows) {
        console.log(`      BIN: ${b.insurance_bin} | GRP: ${b.insurance_group || 'NULL'} | status: ${b.coverage_status} | excluded: ${b.is_excluded} | claims: ${b.verified_claim_count}`);
      }
    }
  }

  // Patient COL,NOE DOB 4/5/1954
  const p2 = await pool.query(`
    SELECT o.opportunity_id, o.trigger_id, o.recommended_drug_name, o.opportunity_type,
      COALESCE(pr.insurance_bin, p.primary_insurance_bin) as bin,
      COALESCE(pr.insurance_group, p.primary_insurance_group) as grp,
      o.prescription_id,
      pr.insurance_bin as rx_bin, pr.insurance_group as rx_grp,
      p.primary_insurance_bin as pat_bin, p.primary_insurance_group as pat_grp
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    WHERE p.last_name ILIKE 'COL%' AND p.first_name ILIKE 'NOE%'
      AND p.date_of_birth = '1954-04-05'
      AND o.pharmacy_id = $1
    ORDER BY o.recommended_drug_name
  `, [bravoId]);

  console.log('\n=== Patient COL,NOE (DOB 04/05/1954) ===');
  for (const r of p2.rows) {
    console.log(`  ${r.recommended_drug_name}`);
    console.log(`    trigger_id: ${r.trigger_id || 'NULL'}`);
    console.log(`    BIN: ${r.bin} | GRP: ${r.grp}`);
    console.log(`    rx_bin: ${r.rx_bin} | rx_grp: ${r.rx_grp} | pat_bin: ${r.pat_bin} | pat_grp: ${r.pat_grp}`);
    console.log(`    prescription_id: ${r.prescription_id || 'NULL'}`);

    if (r.trigger_id) {
      const tbv = await pool.query(`
        SELECT insurance_bin, insurance_group, coverage_status, is_excluded, verified_claim_count
        FROM trigger_bin_values
        WHERE trigger_id = $1
        ORDER BY insurance_bin, insurance_group
      `, [r.trigger_id]);
      console.log(`    trigger_bin_values (${tbv.rowCount} entries):`);
      for (const b of tbv.rows) {
        console.log(`      BIN: ${b.insurance_bin} | GRP: ${b.insurance_group || 'NULL'} | status: ${b.coverage_status} | excluded: ${b.is_excluded} | claims: ${b.verified_claim_count}`);
      }
    }
  }

  // Overall stats: how many opps have trigger_id vs not, prescription_id vs not
  const stats = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(trigger_id) as with_trigger,
      COUNT(prescription_id) as with_rx,
      COUNT(CASE WHEN trigger_id IS NOT NULL AND prescription_id IS NOT NULL THEN 1 END) as with_both
    FROM opportunities
    WHERE pharmacy_id = $1
  `, [bravoId]);
  console.log('\n=== Bravo Stats ===');
  console.log(stats.rows[0]);

  await pool.end();
}
run();
