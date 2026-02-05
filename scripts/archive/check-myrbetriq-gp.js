import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  // Check what GP values Myrbetriq prescriptions have
  const gps = await pool.query(`
    SELECT
      drug_name,
      COALESCE(
        (raw_data->>'Gross Profit')::numeric,
        COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0) - COALESCE(acquisition_cost, 0)
      ) as gross_profit,
      insurance_pay, patient_pay, acquisition_cost,
      raw_data->>'Gross Profit' as raw_gp,
      insurance_bin as bin,
      pharmacy_id
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%MYRBETRIQ%'
    ORDER BY pharmacy_id
    LIMIT 20
  `);
  console.log('Myrbetriq prescription GP values:');
  gps.rows.forEach(r => {
    console.log(`  drug: ${r.drug_name} | GP: ${r.gross_profit} | ins_pay: ${r.insurance_pay} | pat_pay: ${r.patient_pay} | acq: ${r.acquisition_cost} | raw_gp: ${r.raw_gp} | bin: ${r.bin}`);
  });

  // Check existing Myrbetriq opportunities
  const existingOpps = await pool.query(`
    SELECT COUNT(*) as cnt, status, pharmacy_id
    FROM opportunities
    WHERE LOWER(current_drug_name) LIKE '%myrbetriq%' OR LOWER(recommended_drug_name) LIKE '%mirabegron%'
    GROUP BY status, pharmacy_id
    ORDER BY pharmacy_id
  `);
  console.log('\nExisting Myrbetriq opps:');
  existingOpps.rows.forEach(r => console.log(`  pharmacy: ${r.pharmacy_id} | status: ${r.status} | count: ${r.cnt}`));

  // Check the scanner logic: what would netGain be?
  // default_gp_value = 193.68 (for generic Mirabegron)
  // netGain = gpValue - currentGP (for non-add-on)
  // If brand Myrbetriq GP > 193.68, netGain would be negative
  console.log('\nBrand Myrbetriq GP stats:');
  const stats = await pool.query(`
    SELECT
      AVG(COALESCE(
        (raw_data->>'Gross Profit')::numeric,
        COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0) - COALESCE(acquisition_cost, 0)
      )) as avg_gp,
      MIN(COALESCE(
        (raw_data->>'Gross Profit')::numeric,
        COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0) - COALESCE(acquisition_cost, 0)
      )) as min_gp,
      MAX(COALESCE(
        (raw_data->>'Gross Profit')::numeric,
        COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0) - COALESCE(acquisition_cost, 0)
      )) as max_gp,
      COUNT(*) as cnt
    FROM prescriptions
    WHERE UPPER(drug_name) LIKE '%MYRBETRIQ%'
  `);
  const s = stats.rows[0];
  console.log(`  Count: ${s.cnt} | Avg GP: ${parseFloat(s.avg_gp).toFixed(2)} | Min GP: ${parseFloat(s.min_gp).toFixed(2)} | Max GP: ${parseFloat(s.max_gp).toFixed(2)}`);
  console.log(`  Default GP for generic: 193.68`);
  console.log(`  Would netGain be positive? avg_gp(${parseFloat(s.avg_gp).toFixed(2)}) < 193.68? ${parseFloat(s.avg_gp) < 193.68}`);

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
