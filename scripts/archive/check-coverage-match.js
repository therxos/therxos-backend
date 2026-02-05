import 'dotenv/config';
import db from './src/database/index.js';

const PARKWAY = 'f0bd945a-836d-422b-8e58-ceb4dda0a12a';

// Check coverage confidence for Parkway opps that have trigger_id
const coverage = await db.query(`
  SELECT
    CASE
      WHEN o.trigger_id IS NULL THEN 'no_trigger'
      WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
      WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
      WHEN tbv.verified_claim_count > 0 THEN 'verified'
      WHEN tbv_bin.coverage_status IN ('verified', 'works') THEN 'likely'
      WHEN tbv_bin.verified_claim_count > 0 THEN 'likely'
      ELSE 'unknown'
    END as confidence,
    COUNT(*) as count
  FROM opportunities o
  LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
  LEFT JOIN patients p ON p.patient_id = o.patient_id
  LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
    AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
    AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
  LEFT JOIN LATERAL (
    SELECT coverage_status, verified_claim_count, avg_reimbursement
    FROM trigger_bin_values
    WHERE trigger_id = o.trigger_id
      AND insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND (coverage_status IN ('verified', 'works') OR verified_claim_count > 0)
    ORDER BY verified_claim_count DESC NULLS LAST
    LIMIT 1
  ) tbv_bin ON tbv.trigger_id IS NULL
  WHERE o.pharmacy_id = $1
    AND o.status = 'Not Submitted'
  GROUP BY 1
  ORDER BY count DESC
`, [PARKWAY]);
console.log('=== Coverage Confidence for Parkway ===');
for (const r of coverage.rows) {
  console.log(r.confidence, ':', r.count);
}

// Check a few opps with trigger_id AND prescription with BIN that should match
const matchable = await db.query(`
  SELECT o.trigger_id, o.recommended_drug_name,
    COALESCE(pr.insurance_bin, p.primary_insurance_bin) as bin,
    COALESCE(pr.insurance_group, p.primary_insurance_group) as grp,
    t.display_name
  FROM opportunities o
  LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
  LEFT JOIN patients p ON p.patient_id = o.patient_id
  LEFT JOIN triggers t ON t.trigger_id = o.trigger_id
  WHERE o.pharmacy_id = $1
    AND o.trigger_id IS NOT NULL
    AND o.status = 'Not Submitted'
    AND COALESCE(pr.insurance_bin, p.primary_insurance_bin) IS NOT NULL
  LIMIT 5
`, [PARKWAY]);

console.log('\n=== Sample matchable opps ===');
for (const m of matchable.rows) {
  console.log('Trigger:', m.display_name, '| BIN:', m.bin, '| GROUP:', m.grp);

  // Check if trigger has ANY bin_values for this BIN
  const tbvForBin = await db.query(`
    SELECT insurance_bin, insurance_group, coverage_status, verified_claim_count
    FROM trigger_bin_values
    WHERE trigger_id = $1 AND insurance_bin = $2
  `, [m.trigger_id, m.bin]);

  if (tbvForBin.rows.length === 0) {
    console.log('  -> No trigger_bin_values for BIN', m.bin);
  } else {
    for (const t of tbvForBin.rows) {
      console.log('  -> tbv:', t.insurance_bin, '|', t.insurance_group, '| status:', t.coverage_status, '| claims:', t.verified_claim_count);
    }
  }
}

// How many triggers have bin_values that match Parkway's top BINs?
const topBins = ['610011', '004336', '610014', '019595', '610097', '015814', '015581', '016904', '610239', '610502'];
const tbvMatches = await db.query(`
  SELECT t.display_name, COUNT(DISTINCT tbv.insurance_bin) as matching_bins
  FROM triggers t
  JOIN trigger_bin_values tbv ON tbv.trigger_id = t.trigger_id
  WHERE tbv.insurance_bin = ANY($1)
    AND t.is_enabled = true
  GROUP BY t.display_name
  ORDER BY matching_bins DESC
  LIMIT 10
`, [topBins]);
console.log('\n=== Triggers with bin_values matching Parkway BINs ===');
for (const r of tbvMatches.rows) {
  console.log(r.display_name, ':', r.matching_bins, 'matching BINs');
}

process.exit(0);
