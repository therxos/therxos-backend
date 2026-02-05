import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false });

async function check() {
  // Check for ANY Comfort Ez claims
  const r1 = await pool.query(`
    SELECT drug_name, ndc, insurance_bin, insurance_group,
           insurance_pay, patient_pay, acquisition_cost,
           (COALESCE(insurance_pay,0) + COALESCE(patient_pay,0) - COALESCE(acquisition_cost,0)) as gp,
           quantity_dispensed, days_supply, dispensed_date
    FROM prescriptions
    WHERE LOWER(drug_name) LIKE '%comfort ez%'
      AND LOWER(drug_name) LIKE '%pen%'
    ORDER BY dispensed_date DESC
    LIMIT 20
  `);
  console.log('=== Comfort Ez Pen Needle claims (all time) ===');
  console.log(r1.rows.length + ' claims found');
  r1.rows.forEach(r => console.log(
    r.dispensed_date?.toISOString().slice(0,10),
    '|', r.insurance_bin, '/', r.insurance_group,
    '| NDC:', r.ndc,
    '|', r.drug_name,
    '| GP:', parseFloat(r.gp || 0).toFixed(2),
    '| Qty:', r.quantity_dispensed,
    '| Ins:', r.insurance_pay, '| Pt:', r.patient_pay
  ));

  // Also check broader comfort ez
  const r2 = await pool.query(`
    SELECT DISTINCT drug_name, COUNT(*) as cnt
    FROM prescriptions
    WHERE LOWER(drug_name) LIKE '%comfort ez%'
    GROUP BY drug_name
    ORDER BY cnt DESC
  `);
  console.log('\n=== All Comfort Ez products ===');
  r2.rows.forEach(r => console.log('  ' + r.drug_name + ' (' + r.cnt + ')'));

  // Also check: what pen needle NDCs exist on these BINs that we might be missing
  const r3 = await pool.query(`
    SELECT DISTINCT drug_name, ndc, COUNT(*) as cnt,
           ROUND(AVG(COALESCE(insurance_pay,0) + COALESCE(patient_pay,0) - COALESCE(acquisition_cost,0))::numeric, 2) as avg_gp,
           ROUND(AVG(quantity_dispensed)::numeric, 0) as avg_qty
    FROM prescriptions
    WHERE insurance_bin IN ('610097','610014','610011','610494','003858','015581','004336','610502')
      AND dispensed_date >= '2025-09-01'
      AND (COALESCE(insurance_pay,0) + COALESCE(patient_pay,0)) > 0
      AND (LOWER(drug_name) LIKE '%pen needle%' OR LOWER(drug_name) LIKE '%pen ndl%'
           OR LOWER(drug_name) LIKE '%pen needles%' OR LOWER(drug_name) LIKE '%comfort ez%pen%'
           OR LOWER(drug_name) LIKE '%comfort ez%needle%')
    GROUP BY drug_name, ndc
    ORDER BY avg_gp DESC
  `);
  console.log('\n=== All pen needle products on target BINs since 9/1/25 (paid) ===');
  r3.rows.forEach(r => console.log(
    'NDC:', (r.ndc || 'NULL').padEnd(14),
    'Avg GP:', String(r.avg_gp).padEnd(8),
    'Avg Qty:', String(r.avg_qty).padEnd(5),
    'Claims:', String(r.cnt).padEnd(4),
    r.drug_name
  ));

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
