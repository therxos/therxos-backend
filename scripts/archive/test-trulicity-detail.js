import 'dotenv/config';
import db from './src/database/index.js';

// Find Trulicity
const pot = await db.query(`
  SELECT pending_type_id, recommended_drug_name, status, opportunity_type
  FROM pending_opportunity_types
  WHERE recommended_drug_name ILIKE '%trulicity%' OR recommended_drug_name ILIKE '%dulaglutide%'
`);
console.log('Trulicity pending types:', pot.rows);

if (pot.rows.length === 0) {
  console.log('No Trulicity in pending_opportunity_types');
  process.exit(0);
}

const item = pot.rows[0];
console.log('\nTesting full detail query for:', item.recommended_drug_name);

// Test query 1: sample opps (the big join)
try {
  const sampleOpps = await db.query(`
    SELECT
      o.opportunity_id,
      o.patient_id,
      o.current_drug_name,
      o.current_margin,
      o.prescriber_name,
      o.potential_margin_gain,
      o.annual_margin_gain,
      o.status as opp_status,
      p.first_name || ' ' || p.last_name as patient_name,
      pr.insurance_bin,
      pr.insurance_group,
      pr.plan_name,
      pr.gross_profit as rx_gross_profit,
      ph.pharmacy_name,
      (SELECT COUNT(*) FROM opportunities o2 WHERE o2.patient_id = o.patient_id AND o2.status != 'Not Submitted') as patient_actioned_count,
      CASE
        WHEN o.trigger_id IS NULL THEN NULL
        WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
        WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
        WHEN tbv.verified_claim_count > 0 THEN 'verified'
        WHEN EXISTS (
          SELECT 1 FROM trigger_bin_values tbv2
          WHERE tbv2.trigger_id = o.trigger_id
            AND tbv2.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
            AND (tbv2.coverage_status IN ('verified', 'works') OR tbv2.verified_claim_count > 0)
        ) THEN 'likely'
        ELSE 'unknown'
      END as coverage_confidence
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    LEFT JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
    LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
      AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
      AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
    WHERE o.recommended_drug_name = $1
    ORDER BY o.annual_margin_gain DESC NULLS LAST
    LIMIT 20
  `, [item.recommended_drug_name]);
  console.log('Sample opps query: OK,', sampleOpps.rows.length, 'rows');
} catch(e) {
  console.log('Sample opps query: FAIL -', e.message);
}

// Test query 2: BIN breakdown
try {
  const bins = await db.query(`
    SELECT
      COALESCE(pr.insurance_bin, 'CASH') as bin,
      COALESCE(pr.insurance_group, '') as grp,
      pr.plan_name,
      COUNT(*) as count,
      COALESCE(SUM(o.annual_margin_gain), 0) as total_margin
    FROM opportunities o
    LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
    WHERE o.recommended_drug_name = $1
    GROUP BY pr.insurance_bin, pr.insurance_group, pr.plan_name
    ORDER BY count DESC
    LIMIT 20
  `, [item.recommended_drug_name]);
  console.log('BIN breakdown: OK,', bins.rows.length, 'rows');
} catch(e) {
  console.log('BIN breakdown: FAIL -', e.message);
}

// Test query 3: approval log
try {
  const log = await db.query(`
    SELECT oal.*, u.first_name, u.last_name, u.email
    FROM opportunity_approval_log oal
    LEFT JOIN users u ON u.user_id = oal.performed_by
    WHERE oal.pending_type_id = $1
    ORDER BY oal.created_at DESC
  `, [item.pending_type_id]);
  console.log('Approval log: OK,', log.rows.length, 'rows');
} catch(e) {
  console.log('Approval log: FAIL -', e.message);
}

// Test query 4: current drug breakdown
try {
  const drugs = await db.query(`
    SELECT o.current_drug_name, COUNT(*) as count
    FROM opportunities o
    WHERE o.recommended_drug_name = $1 AND o.current_drug_name IS NOT NULL
    GROUP BY o.current_drug_name
    ORDER BY count DESC
    LIMIT 20
  `, [item.recommended_drug_name]);
  console.log('Current drug breakdown: OK,', drugs.rows.length, 'rows');
} catch(e) {
  console.log('Current drug breakdown: FAIL -', e.message);
}

process.exit(0);
