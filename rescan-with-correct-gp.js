import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';
const EXCLUDED_BINS = ['014798'];

async function rescan() {
  console.log('='.repeat(80));
  console.log('RESCANNING HEIGHTS CHEMIST WITH UPDATED MEDICAID GP VALUES');
  console.log('='.repeat(80));

  // Get current totals
  const before = await pool.query(`
    SELECT COUNT(*) as cnt, SUM(annual_margin_gain) as total
    FROM opportunities WHERE pharmacy_id = $1
  `, [pharmacyId]);
  console.log(`\nBefore: ${before.rows[0].cnt} opportunities, $${Number(before.rows[0].total).toLocaleString()} annual`);

  // Delete existing opportunities
  console.log('\nDeleting existing opportunities...');
  await pool.query('DELETE FROM opportunities WHERE pharmacy_id = $1', [pharmacyId]);

  // Load prescriptions
  const rxResult = await pool.query(`
    SELECT
      r.prescription_id, r.patient_id, r.drug_name, r.ndc,
      r.quantity_dispensed as quantity, r.days_supply,
      r.dispensed_date, r.insurance_bin as bin,
      r.insurance_group as group_number,
      p.first_name as patient_first_name, p.last_name as patient_last_name,
      p.primary_insurance_bin
    FROM prescriptions r
    JOIN patients p ON p.patient_id = r.patient_id
    WHERE r.pharmacy_id = $1
    ORDER BY r.patient_id, r.dispensed_date DESC
  `, [pharmacyId]);
  console.log(`Loaded ${rxResult.rows.length} prescriptions`);

  // Load triggers with BIN values (including updated Medicaid values!)
  const triggersResult = await pool.query(`
    SELECT t.*,
      COALESCE(
        json_agg(
          json_build_object(
            'bin', tbv.insurance_bin,
            'gp_value', tbv.gp_value,
            'is_excluded', tbv.is_excluded
          )
        ) FILTER (WHERE tbv.id IS NOT NULL),
        '[]'
      ) as bin_values
    FROM triggers t
    LEFT JOIN trigger_bin_values tbv ON t.trigger_id = tbv.trigger_id
    WHERE t.is_enabled = true
    GROUP BY t.trigger_id
  `);
  console.log(`Loaded ${triggersResult.rows.length} triggers`);

  // Group prescriptions by patient
  const patientRxMap = new Map();
  for (const rx of rxResult.rows) {
    if (!patientRxMap.has(rx.patient_id)) {
      patientRxMap.set(rx.patient_id, []);
    }
    patientRxMap.get(rx.patient_id).push(rx);
  }

  let newOpportunities = 0;
  const createdOpps = new Set();
  const gpByBin = { '004740': 0, '004336': 0, 'other': 0 };
  const countByBin = { '004740': 0, '004336': 0, 'other': 0 };

  for (const [patientId, patientRxs] of patientRxMap) {
    const patientDrugs = patientRxs.map(rx => (rx.drug_name || '').toUpperCase());
    const patientBin = patientRxs[0]?.bin;
    const patientPrimaryBin = patientRxs[0]?.primary_insurance_bin;

    if (EXCLUDED_BINS.includes(patientPrimaryBin)) continue;

    for (const trigger of triggersResult.rows) {
      const detectKeywords = trigger.detection_keywords || [];
      const excludeKeywords = trigger.exclude_keywords || [];
      const ifHasKeywords = trigger.if_has_keywords || [];
      const ifNotHasKeywords = trigger.if_not_has_keywords || [];

      // Find matching drug
      let matchedDrug = null;
      let matchedRx = null;
      for (const rx of patientRxs) {
        const drugUpper = rx.drug_name?.toUpperCase() || '';
        const matchesDetect = detectKeywords.some(kw => drugUpper.includes(kw.toUpperCase()));
        if (!matchesDetect) continue;
        const matchesExclude = excludeKeywords.some(kw => drugUpper.includes(kw.toUpperCase()));
        if (matchesExclude) continue;
        matchedDrug = rx.drug_name;
        matchedRx = rx;
        break;
      }

      if (!matchedDrug) continue;

      // Check IF_HAS condition
      if (ifHasKeywords.length > 0) {
        const hasRequired = ifHasKeywords.some(kw =>
          patientDrugs.some(d => d.includes(kw.toUpperCase()))
        );
        if (!hasRequired) continue;
      }

      // Check IF_NOT_HAS condition
      if (ifNotHasKeywords.length > 0) {
        const hasForbidden = ifNotHasKeywords.some(kw =>
          patientDrugs.some(d => d.includes(kw.toUpperCase()))
        );
        if (hasForbidden) continue;
      }

      // Get GP value for this BIN - THIS IS THE KEY PART
      let gpValue = trigger.default_gp_value || 50;
      const binValues = trigger.bin_values || [];
      const binConfig = binValues.find(bv => bv.bin === patientBin);
      if (binConfig) {
        if (binConfig.is_excluded) continue; // Skip excluded BINs
        if (binConfig.gp_value) gpValue = parseFloat(binConfig.gp_value);
      }

      // Check for duplicates
      const oppKey = `${patientId}|${trigger.trigger_type}|${(matchedDrug || '').toUpperCase()}`;
      if (createdOpps.has(oppKey)) continue;

      // Create opportunity with correct GP
      const annualGp = gpValue * 12;
      const clinicalRationale = trigger.clinical_rationale || `${trigger.trigger_type}: ${trigger.display_name || 'Opportunity'}`;

      await pool.query(`
        INSERT INTO opportunities (
          pharmacy_id, patient_id, opportunity_type,
          current_drug_name, recommended_drug, recommended_drug_name,
          status, potential_margin_gain, annual_margin_gain,
          clinical_rationale, avg_dispensed_qty
        ) VALUES ($1, $2, $3, $4, $5, $6, 'Not Submitted', $7, $8, $9, $10)
      `, [
        pharmacyId,
        patientId,
        trigger.trigger_type,
        matchedDrug,
        trigger.recommended_drug,
        trigger.recommended_drug,
        gpValue,
        annualGp,
        clinicalRationale,
        matchedRx?.quantity || null
      ]);

      newOpportunities++;
      createdOpps.add(oppKey);

      // Track by BIN
      const binKey = patientBin === '004740' ? '004740' : patientBin === '004336' ? '004336' : 'other';
      gpByBin[binKey] += annualGp;
      countByBin[binKey]++;
    }
  }

  // Get new totals
  const after = await pool.query(`
    SELECT COUNT(*) as cnt, SUM(annual_margin_gain) as total,
           SUM(potential_margin_gain) as monthly
    FROM opportunities WHERE pharmacy_id = $1
  `, [pharmacyId]);

  console.log('\n' + '='.repeat(80));
  console.log('RESCAN COMPLETE');
  console.log('='.repeat(80));
  console.log(`Created ${newOpportunities} opportunities`);
  console.log(`\nNew Totals:`);
  console.log(`  Monthly potential: $${Number(after.rows[0].monthly).toLocaleString()}`);
  console.log(`  Annual potential: $${Number(after.rows[0].total).toLocaleString()}`);

  console.log(`\nBreakdown by BIN:`);
  console.log(`  BIN 004740 (Medicaid): ${countByBin['004740']} opps, $${gpByBin['004740'].toLocaleString()} annual`);
  console.log(`  BIN 004336 (CVS): ${countByBin['004336']} opps, $${gpByBin['004336'].toLocaleString()} annual`);
  console.log(`  Other BINs: ${countByBin['other']} opps, $${gpByBin['other'].toLocaleString()} annual`);

  await pool.end();
}

rescan().catch(console.error);
