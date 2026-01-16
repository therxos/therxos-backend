import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function rescan() {
  console.log('Starting CVS aberrant scan for Heights Chemist...');

  // Get existing flags to avoid duplicates
  const existingFlagsResult = await pool.query(
    'SELECT patient_id, rule_type, drug_name, dispensed_date FROM audit_flags WHERE pharmacy_id = $1',
    [pharmacyId]
  );
  const existingFlags = new Set(
    existingFlagsResult.rows.map(f => `${f.patient_id}|${f.rule_type}|${(f.drug_name || '').toUpperCase()}|${f.dispensed_date}`)
  );
  console.log(`Found ${existingFlags.size} existing flags`);

  // Load CVS managed BINs
  const cvsBinsResult = await pool.query('SELECT bin FROM cvs_managed_bins');
  const cvsBins = new Set(cvsBinsResult.rows.map(r => r.bin));
  console.log(`Loaded ${cvsBins.size} CVS managed BINs`);

  // Load aberrant NDCs
  const aberrantResult = await pool.query('SELECT ndc, product_name FROM cvs_aberrant_products');
  const aberrantNdcs = new Map();
  for (const row of aberrantResult.rows) {
    aberrantNdcs.set(row.ndc, row.product_name);
    aberrantNdcs.set(row.ndc.replace(/^0+/, ''), row.product_name);
  }
  console.log(`Loaded ${aberrantResult.rows.length} aberrant products`);

  // Get all prescriptions
  const prescriptions = await pool.query(`
    SELECT
      prescription_id, patient_id, drug_name, ndc, quantity_dispensed, days_supply,
      daw_code, sig, insurance_bin, insurance_pay, acquisition_cost, dispensed_date
    FROM prescriptions
    WHERE pharmacy_id = $1
  `, [pharmacyId]);
  console.log(`Scanning ${prescriptions.rows.length} prescriptions...`);

  let cvsAberrantFlags = 0;
  let skipped = 0;

  for (const rx of prescriptions.rows) {
    const rxBin = rx.insurance_bin || '';
    if (!cvsBins.has(rxBin)) continue;

    const rxNdc = (rx.ndc || '').replace(/-/g, '');
    const aberrantProduct = aberrantNdcs.get(rxNdc) || aberrantNdcs.get(rxNdc.replace(/^0+/, ''));
    if (!aberrantProduct) continue;

    const drugUpper = rx.drug_name?.toUpperCase() || '';
    const flagKey = `${rx.patient_id}|cvs_aberrant|${drugUpper}|${rx.dispensed_date}`;
    if (existingFlags.has(flagKey)) {
      skipped++;
      continue;
    }

    const grossProfit = (parseFloat(rx.insurance_pay) || 0) - (parseFloat(rx.acquisition_cost) || 0);
    const violation = `CVS ABERRANT PRODUCT: ${rx.drug_name} (NDC: ${rxNdc}) is on CVS Caremark's Aberrant Product List. Dispensing >25% of claims from this list can result in network termination.`;

    await pool.query(`
      INSERT INTO audit_flags (
        pharmacy_id, patient_id, prescription_id, rule_id,
        rule_type, severity, drug_name, ndc, dispensed_quantity,
        days_supply, daw_code, sig, gross_profit,
        violation_message, expected_value, actual_value,
        status, dispensed_date
      ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    `, [
      pharmacyId,
      rx.patient_id,
      rx.prescription_id,
      'cvs_aberrant',
      'high',
      rx.drug_name,
      rx.ndc,
      rx.quantity_dispensed,
      rx.days_supply,
      rx.daw_code,
      rx.sig,
      grossProfit,
      violation,
      'Avoid aberrant products',
      `BIN: ${rxBin}, NDC on aberrant list`,
      'open',
      rx.dispensed_date
    ]);

    cvsAberrantFlags++;
    existingFlags.add(flagKey);
  }

  console.log(`\nResults:`);
  console.log(`- CVS aberrant flags created: ${cvsAberrantFlags}`);
  console.log(`- Skipped (already flagged): ${skipped}`);

  // Now get the metrics
  console.log('\n--- CVS Aberrant Metrics ---');

  const cvsRxResult = await pool.query(`
    SELECT
      ndc,
      COALESCE(insurance_pay, 0) as insurance_pay,
      drug_name
    FROM prescriptions
    WHERE pharmacy_id = $1
      AND insurance_bin = ANY($2)
  `, [pharmacyId, Array.from(cvsBins)]);

  let totalCvsRxCount = 0;
  let totalCvsInsurancePaid = 0;
  let aberrantRxCount = 0;
  let aberrantInsurancePaid = 0;

  for (const rx of cvsRxResult.rows) {
    totalCvsRxCount++;
    totalCvsInsurancePaid += parseFloat(rx.insurance_pay) || 0;

    const rxNdc = (rx.ndc || '').replace(/-/g, '');
    const isAberrant = aberrantNdcs.has(rxNdc) || aberrantNdcs.has(rxNdc.replace(/^0+/, ''));

    if (isAberrant) {
      aberrantRxCount++;
      aberrantInsurancePaid += parseFloat(rx.insurance_pay) || 0;
    }
  }

  const percentByCount = totalCvsRxCount > 0 ? (aberrantRxCount / totalCvsRxCount) * 100 : 0;
  const percentByDollars = totalCvsInsurancePaid > 0 ? (aberrantInsurancePaid / totalCvsInsurancePaid) * 100 : 0;

  console.log(`Total CVS Rx Count: ${totalCvsRxCount}`);
  console.log(`Total CVS Insurance Paid: $${totalCvsInsurancePaid.toLocaleString()}`);
  console.log(`Aberrant Rx Count: ${aberrantRxCount}`);
  console.log(`Aberrant Insurance Paid: $${aberrantInsurancePaid.toLocaleString()}`);
  console.log(`\nPercent by Count: ${percentByCount.toFixed(2)}%`);
  console.log(`Percent by Dollars: ${percentByDollars.toFixed(2)}%`);

  const maxPercent = Math.max(percentByCount, percentByDollars);
  if (maxPercent >= 25) {
    console.log('\n⛔ CRITICAL: Exceeds 25% threshold - risk of network termination');
  } else if (maxPercent >= 20) {
    console.log('\n⚠️  WARNING: Approaching 25% threshold');
  } else {
    console.log('\n✅ SAFE: Below 20% threshold');
  }

  await pool.end();
}

rescan().catch(console.error);
