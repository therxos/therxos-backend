import 'dotenv/config';
import db from './src/database/index.js';

const PARKWAY = 'f0bd945a-836d-422b-8e58-ceb4dda0a12a';

// Check if prescriptions actually have insurance_bin populated
const binCheck = await db.query(`
  SELECT
    COUNT(*) as total,
    COUNT(insurance_bin) as has_bin,
    COUNT(CASE WHEN insurance_bin IS NOT NULL AND insurance_bin != '' THEN 1 END) as has_nonempty_bin
  FROM prescriptions
  WHERE pharmacy_id = $1
    AND dispensed_date > NOW() - INTERVAL '90 days'
`, [PARKWAY]);
console.log('=== Prescription BIN population ===');
console.log(binCheck.rows[0]);

// Check the specific prescriptions linked to opps
const oppRx = await db.query(`
  SELECT
    COUNT(*) as total_opps,
    COUNT(o.prescription_id) as has_rx_link,
    COUNT(pr.insurance_bin) as rx_has_bin
  FROM opportunities o
  LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
  WHERE o.pharmacy_id = $1
    AND o.trigger_id IS NOT NULL
    AND o.status = 'Not Submitted'
`, [PARKWAY]);
console.log('\n=== Opps with trigger_id - prescription BIN check ===');
console.log(oppRx.rows[0]);

// Check if patient primary_insurance_bin is set
const patBin = await db.query(`
  SELECT
    COUNT(*) as total,
    COUNT(primary_insurance_bin) as has_primary_bin
  FROM patients
  WHERE pharmacy_id = $1
`, [PARKWAY]);
console.log('\n=== Patient primary_insurance_bin ===');
console.log(patBin.rows[0]);

// Sample some prescriptions with and without BIN
const sampleWithBin = await db.query(`
  SELECT prescription_id, drug_name, insurance_bin, insurance_group, bin, pcn, group_number
  FROM prescriptions
  WHERE pharmacy_id = $1
    AND insurance_bin IS NOT NULL AND insurance_bin != ''
  LIMIT 3
`, [PARKWAY]);
console.log('\n=== Sample prescriptions WITH insurance_bin ===');
for (const r of sampleWithBin.rows) {
  console.log('drug:', r.drug_name, '| insurance_bin:', r.insurance_bin, '| bin:', r.bin, '| insurance_group:', r.insurance_group, '| group_number:', r.group_number);
}

const sampleWithoutBin = await db.query(`
  SELECT prescription_id, drug_name, insurance_bin, insurance_group, bin, pcn, group_number
  FROM prescriptions
  WHERE pharmacy_id = $1
    AND (insurance_bin IS NULL OR insurance_bin = '')
  LIMIT 3
`, [PARKWAY]);
console.log('\n=== Sample prescriptions WITHOUT insurance_bin ===');
for (const r of sampleWithoutBin.rows) {
  console.log('drug:', r.drug_name, '| insurance_bin:', r.insurance_bin, '| bin:', r.bin, '| insurance_group:', r.insurance_group, '| group_number:', r.group_number);
}

// Check what columns have BIN data (could be 'bin' vs 'insurance_bin')
const colCheck = await db.query(`
  SELECT
    COUNT(CASE WHEN insurance_bin IS NOT NULL AND insurance_bin != '' THEN 1 END) as has_insurance_bin,
    COUNT(CASE WHEN bin IS NOT NULL AND bin != '' THEN 1 END) as has_bin
  FROM prescriptions
  WHERE pharmacy_id = $1
`, [PARKWAY]);
console.log('\n=== Column check: insurance_bin vs bin ===');
console.log(colCheck.rows[0]);

process.exit(0);
