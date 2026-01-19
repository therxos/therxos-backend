import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function fix() {
  console.log('Cleaning up opportunities that violate BIN restrictions...\n');

  // DROPLET pen needles - should ONLY be for BIN 015581
  const dropletResult = await pool.query(`
    DELETE FROM opportunities
    WHERE recommended_drug_name ILIKE '%droplet%'
    AND status = 'Not Submitted'
    AND opportunity_id IN (
      SELECT o.opportunity_id
      FROM opportunities o
      JOIN prescriptions p ON p.patient_id = o.patient_id AND p.pharmacy_id = o.pharmacy_id
      WHERE o.recommended_drug_name ILIKE '%droplet%'
      AND o.status = 'Not Submitted'
      AND (p.insurance_bin IS NULL OR p.insurance_bin != '015581')
    )
    RETURNING opportunity_id
  `);
  console.log(`Removed ${dropletResult.rows.length} DROPLET opportunities with wrong BIN (not 015581)`);

  // Verifine lancets - should ONLY be for BIN 610502
  const verifineResult = await pool.query(`
    DELETE FROM opportunities
    WHERE recommended_drug_name ILIKE '%verifine%'
    AND status = 'Not Submitted'
    AND opportunity_id IN (
      SELECT o.opportunity_id
      FROM opportunities o
      JOIN prescriptions p ON p.patient_id = o.patient_id AND p.pharmacy_id = o.pharmacy_id
      WHERE o.recommended_drug_name ILIKE '%verifine%'
      AND o.status = 'Not Submitted'
      AND (p.insurance_bin IS NULL OR p.insurance_bin != '610502')
    )
    RETURNING opportunity_id
  `);
  console.log(`Removed ${verifineResult.rows.length} VERIFINE opportunities with wrong BIN (not 610502)`);

  // GNP pen needles - should ONLY be for BIN 004336 or 610502
  const gnpResult = await pool.query(`
    DELETE FROM opportunities
    WHERE recommended_drug_name ILIKE '%gnp%pen%'
    AND status = 'Not Submitted'
    AND opportunity_id IN (
      SELECT o.opportunity_id
      FROM opportunities o
      JOIN prescriptions p ON p.patient_id = o.patient_id AND p.pharmacy_id = o.pharmacy_id
      WHERE o.recommended_drug_name ILIKE '%gnp%pen%'
      AND o.status = 'Not Submitted'
      AND (p.insurance_bin IS NULL OR p.insurance_bin NOT IN ('004336', '610502'))
    )
    RETURNING opportunity_id
  `);
  console.log(`Removed ${gnpResult.rows.length} GNP opportunities with wrong BIN (not 004336 or 610502)`);

  // Show remaining counts
  console.log('\n--- Remaining opportunities by type ---');
  const remaining = await pool.query(`
    SELECT
      CASE
        WHEN recommended_drug_name ILIKE '%droplet%' THEN 'DROPLET'
        WHEN recommended_drug_name ILIKE '%verifine%' THEN 'VERIFINE'
        WHEN recommended_drug_name ILIKE '%gnp%pen%' THEN 'GNP'
        WHEN recommended_drug_name ILIKE '%comfort ez%' THEN 'COMFORT EZ'
        WHEN recommended_drug_name ILIKE '%pure comfort%' THEN 'PURE COMFORT'
        ELSE 'OTHER'
      END as product,
      COUNT(*) as count
    FROM opportunities
    WHERE status = 'Not Submitted'
    AND (
      recommended_drug_name ILIKE '%droplet%'
      OR recommended_drug_name ILIKE '%verifine%'
      OR recommended_drug_name ILIKE '%gnp%'
      OR recommended_drug_name ILIKE '%comfort%'
      OR recommended_drug_name ILIKE '%pen needle%'
      OR recommended_drug_name ILIKE '%lancet%'
    )
    GROUP BY 1
    ORDER BY 1
  `);
  remaining.rows.forEach(r => console.log(`  ${r.product}: ${r.count}`));

  await pool.end();
}

fix().catch(console.error);
