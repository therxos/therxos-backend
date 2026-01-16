import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';
const EXCLUDED_BINS = ['014798']; // Cash BIN

async function rescan() {
  console.log('Starting opportunity rescan for Heights Chemist...\n');

  // Load prescriptions with patient info
  const rxResult = await pool.query(`
    SELECT
      r.prescription_id, r.patient_id, r.drug_name, r.ndc,
      r.quantity_dispensed as quantity, r.days_supply,
      r.dispensed_date, r.insurance_bin as bin, r.insurance_pcn as pcn,
      r.insurance_group as group_number,
      COALESCE(
        (r.raw_data->>'Gross Profit')::numeric,
        COALESCE(r.insurance_pay, 0) + COALESCE(r.patient_pay, 0) - COALESCE(r.acquisition_cost, 0)
      ) as gross_profit,
      r.daw_code, r.sig, r.prescriber_name,
      p.first_name as patient_first_name, p.last_name as patient_last_name,
      p.primary_insurance_bin
    FROM prescriptions r
    JOIN patients p ON p.patient_id = r.patient_id
    WHERE r.pharmacy_id = $1
    ORDER BY r.patient_id, r.dispensed_date DESC
  `, [pharmacyId]);

  const prescriptions = rxResult.rows;
  console.log(`Loaded ${prescriptions.length} prescriptions`);

  // Load enabled triggers with BIN values
  const triggersResult = await pool.query(`
    SELECT t.*,
      COALESCE(
        json_agg(
          json_build_object('bin', tbv.insurance_bin, 'gp_value', tbv.gp_value, 'is_excluded', tbv.is_excluded)
        ) FILTER (WHERE tbv.id IS NOT NULL),
        '[]'
      ) as bin_values
    FROM triggers t
    LEFT JOIN trigger_bin_values tbv ON t.trigger_id = tbv.trigger_id
    WHERE t.is_enabled = true
    GROUP BY t.trigger_id
  `);
  const triggers = triggersResult.rows;
  console.log(`Loaded ${triggers.length} triggers`);

  // Get existing opportunities to avoid duplicates
  const existingOppsResult = await pool.query(`
    SELECT patient_id, opportunity_type, COALESCE(current_drug_name, '') as current_drug_name
    FROM opportunities
    WHERE pharmacy_id = $1
  `, [pharmacyId]);
  const existingOpps = new Set(
    existingOppsResult.rows.map(o => `${o.patient_id}|${o.opportunity_type}|${(o.current_drug_name || '').toUpperCase()}`)
  );
  console.log(`Existing opportunities: ${existingOpps.size}`);

  // Group prescriptions by patient
  const patientRxMap = new Map();
  for (const rx of prescriptions) {
    if (!patientRxMap.has(rx.patient_id)) {
      patientRxMap.set(rx.patient_id, []);
    }
    patientRxMap.get(rx.patient_id).push(rx);
  }

  let newOpportunities = 0;
  let skippedOpportunities = 0;
  const opportunityBreakdown = {};

  // Scan each patient
  for (const [patientId, patientRxs] of patientRxMap) {
    const patientDrugs = patientRxs.map(rx => (rx.drug_name || '').toUpperCase());
    const patientBin = patientRxs[0]?.bin;
    const patientGroup = patientRxs[0]?.group_number;
    const patientPrimaryBin = patientRxs[0]?.primary_insurance_bin;

    // Skip excluded BINs
    if (EXCLUDED_BINS.includes(patientPrimaryBin)) continue;

    for (const trigger of triggers) {
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

      // Get GP value for this BIN
      let gpValue = trigger.default_gp_value || 50;
      const binValues = trigger.bin_values || [];
      const binConfig = binValues.find(bv => bv.bin === patientBin);
      if (binConfig) {
        if (binConfig.is_excluded) continue;
        if (binConfig.gp_value) gpValue = binConfig.gp_value;
      }

      // Check if opportunity already exists
      const oppKey = `${patientId}|${trigger.trigger_type}|${(matchedDrug || '').toUpperCase()}`;
      if (existingOpps.has(oppKey)) {
        skippedOpportunities++;
        continue;
      }

      // Create opportunity
      const clinicalRationale = trigger.clinical_rationale || `${trigger.trigger_type}: ${trigger.display_name || 'Opportunity detected'}`;
      await pool.query(`
        INSERT INTO opportunities (
          pharmacy_id, patient_id, opportunity_type,
          current_drug_name, recommended_drug, recommended_drug_name, status,
          annual_margin_gain, potential_margin_gain, clinical_rationale, avg_dispensed_qty
        ) VALUES ($1, $2, $3, $4, $5, $6, 'Not Submitted', $7, $7, $8, $9)
      `, [
        pharmacyId,
        patientId,
        trigger.trigger_type,
        matchedDrug,
        trigger.recommended_drug,
        trigger.recommended_drug,
        gpValue,
        clinicalRationale,
        matchedRx?.quantity || null
      ]);

      newOpportunities++;
      existingOpps.add(oppKey);

      // Track breakdown
      const triggerKey = trigger.display_name || trigger.trigger_type;
      if (!opportunityBreakdown[triggerKey]) {
        opportunityBreakdown[triggerKey] = { count: 0, totalGp: 0, bin004740: 0 };
      }
      opportunityBreakdown[triggerKey].count++;
      opportunityBreakdown[triggerKey].totalGp += gpValue;
      if (patientBin === '004740') opportunityBreakdown[triggerKey].bin004740++;
    }
  }

  console.log(`\n${'='.repeat(90)}`);
  console.log('RESCAN COMPLETE');
  console.log('='.repeat(90));
  console.log(`New opportunities created: ${newOpportunities}`);
  console.log(`Skipped (already exist): ${skippedOpportunities}`);

  // Get total opportunities now
  const totalResult = await pool.query(`
    SELECT COUNT(*) as cnt, SUM(annual_margin_gain) as total_annual
    FROM opportunities WHERE pharmacy_id = $1
  `, [pharmacyId]);

  console.log(`\nTotal opportunities: ${totalResult.rows[0].cnt}`);
  console.log(`Total annual potential: $${Number(totalResult.rows[0].total_annual || 0).toLocaleString()}`);

  // Show breakdown by trigger
  if (newOpportunities > 0) {
    console.log(`\n${'='.repeat(90)}`);
    console.log('NEW OPPORTUNITIES BY TRIGGER');
    console.log('='.repeat(90));
    console.log('Trigger'.padEnd(50) + ' | Count | Total GP  | BIN 004740');
    console.log('-'.repeat(90));

    const sortedTriggers = Object.entries(opportunityBreakdown)
      .sort((a, b) => b[1].totalGp - a[1].totalGp);

    for (const [trigger, data] of sortedTriggers) {
      console.log(
        trigger.substring(0, 48).padEnd(50),
        '|', String(data.count).padStart(5),
        '|', ('$' + Math.round(data.totalGp)).padStart(9),
        '|', String(data.bin004740).padStart(7)
      );
    }
  }

  // Show opportunity type breakdown
  console.log(`\n${'='.repeat(90)}`);
  console.log('OPPORTUNITY BREAKDOWN BY TYPE');
  console.log('='.repeat(90));

  const typeBreakdown = await pool.query(`
    SELECT opportunity_type, COUNT(*) as cnt, SUM(annual_margin_gain) as total_gp
    FROM opportunities WHERE pharmacy_id = $1
    GROUP BY opportunity_type
    ORDER BY total_gp DESC
  `, [pharmacyId]);

  console.log('Type'.padEnd(25) + ' | Opps  | Total Annual GP');
  console.log('-'.repeat(55));
  for (const row of typeBreakdown.rows) {
    console.log(
      (row.opportunity_type || 'Unknown').padEnd(25),
      '|', String(row.cnt).padStart(5),
      '|', ('$' + Number(row.total_gp || 0).toLocaleString()).padStart(15)
    );
  }

  await pool.end();
}

rescan().catch(console.error);
