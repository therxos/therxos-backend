// TheRxOS V2 - PrimeRx CSV Data Ingestion Script
// Run with: node ingest-primerx.js <client-email> <csv-file-path>

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import fs from 'fs';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BATCH_SIZE = 500;

// PrimeRx Column mapping
const COLUMN_MAP = {
  'DATE FILLED / ORDERED': 'date_filled',
  'RXNO': 'rx_number',
  'PATIENTNAME': 'patient_name',
  'PATDOB': 'patient_dob',
  'PRIINS': 'insurance_name',
  'PRIINSBINNO': 'insurance_bin',
  'PRIINSPATGROUP': 'group_number',
  'DAW': 'daw_code',
  'DRUGNAME': 'drug_name',
  'NDC': 'ndc',
  'QUANT': 'quantity',
  'DAYS': 'days_supply',
  'TOTALINSPAID': 'insurance_pay',
  'TOTALCOST': 'total_cost',
  'DIAGCODE1': 'diag_code',
  'DRUGTHERAPY': 'therapeutic_class',
  'PACKAGESIZE': 'package_size',
  'PRESNAME': 'prescriber_name',
  'PRESFAXNO#': 'prescriber_fax',
};
// Case-insensitive lookup version
const COLUMN_MAP_LOWER = Object.fromEntries(
  Object.entries(COLUMN_MAP).map(([k, v]) => [k.toLowerCase(), v])
);

function parseCSVLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(content) {
  const lines = content.trim().split('\n');
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const headers = parseCSVLine(lines[0], delimiter);

  console.log(`   Delimiter: ${delimiter === '\t' ? 'TAB' : 'COMMA'}, Columns: ${headers.length}`);
  console.log(`   Headers: ${headers.join(', ')}`);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i], delimiter);
    const row = {};
    headers.forEach((header, index) => {
      const mappedKey = COLUMN_MAP[header] || COLUMN_MAP_LOWER[header.toLowerCase()] || header.toLowerCase().replace(/\s+/g, '_').replace(/[#]/g, '');
      row[mappedKey] = values[index] || null;
    });
    rows.push(row);
  }
  return rows;
}

function generatePatientHash(name, dob) {
  const cleanName = (name || '').replace(/\([^)]*\)/g, '').trim();
  return createHash('sha256').update(`${cleanName}|${dob}`.toLowerCase()).digest('hex');
}

// PrimeRx date format: "M-D-YYYY" or "M-D-YYYY \ M-D-YYYY" (filled \ ordered)
function parsePrimeRxDate(dateStr) {
  if (!dateStr) return null;
  // Take the first date if there are two (filled \ ordered)
  const firstDate = dateStr.split('\\')[0].trim();
  const parts = firstDate.split('-');
  if (parts.length === 3) {
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return dateStr;
}

// PrimeRx DOB format: "M/D/YYYY 12:00:00 AM"
function parsePrimeRxDOB(dobStr) {
  if (!dobStr) return null;
  // Remove time portion
  const dateOnly = dobStr.split(' ')[0];
  const parts = dateOnly.split('/');
  if (parts.length === 3) {
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return dobStr;
}

// PrimeRx patient name format: "LAST . FIRST" or "LAST . FIRST MIDDLE"
function parsePrimeRxName(nameStr) {
  if (!nameStr) return { firstName: '', lastName: '' };
  const parts = nameStr.split(' . ');
  const lastName = (parts[0] || '').trim();
  const firstName = (parts[1] || '').trim();
  return { firstName, lastName };
}

// PrimeRx drug name includes NDC in parentheses - clean it
function cleanDrugName(drugName) {
  if (!drugName) return '';
  // Remove NDC in parentheses at the end: "DRUG NAME (12345-6789-01)" -> "DRUG NAME"
  return drugName.replace(/\s*\([0-9-]+\)\s*$/, '').trim();
}

function parseAmount(amountStr) {
  if (!amountStr) return 0;
  return parseFloat(String(amountStr).replace(/[$,]/g, '')) || 0;
}

function inferConditions(therapeuticClass) {
  const conditions = [];
  const tc = (therapeuticClass || '').toUpperCase();

  if (tc.includes('DIABETES') || tc.includes('INSULIN') || tc.includes('BIGUANIDE') || tc.includes('SULFONYLUREA') || tc.includes('ANTIDIABETIC')) conditions.push('Diabetes');
  if (tc.includes('ANTIHYPERTENSIVE') || tc.includes('BETA BLOCK') || tc.includes('CALCIUM CHANNEL') || tc.includes('ACE INHIBITOR') || tc.includes('DIURETIC')) conditions.push('Hypertension');
  if (tc.includes('LIPID') || tc.includes('STATIN') || tc.includes('CHOLESTEROL') || tc.includes('ANTILIPEMIC')) conditions.push('Hyperlipidemia');
  if (tc.includes('ANTIDEPRESSANT') || tc.includes('SSRI') || tc.includes('SNRI')) conditions.push('Depression');
  if (tc.includes('BRONCHODILATOR') || tc.includes('COPD') || tc.includes('ASTHMA') || tc.includes('RESPIRATORY')) conditions.push('COPD/Asthma');
  if (tc.includes('THYROID')) conditions.push('Thyroid');
  if (tc.includes('PROTON PUMP') || tc.includes('PPI') || tc.includes('GERD') || tc.includes('ANTACID')) conditions.push('GERD');
  if (tc.includes('ANTICOAGULANT') || tc.includes('BLOOD THIN')) conditions.push('Anticoagulation');
  if (tc.includes('MUSCULO') || tc.includes('OSTEOPOROSIS') || tc.includes('BONE')) conditions.push('Bone Health');

  return [...new Set(conditions)];
}

async function ingestData(clientEmail, csvFilePath) {
  console.log(`\n🚀 PrimeRx ingestion for ${clientEmail}...\n`);

  // Get client info
  const clientResult = await pool.query(`
    SELECT c.client_id, p.pharmacy_id, c.client_name
    FROM clients c JOIN pharmacies p ON p.client_id = c.client_id
    WHERE c.submitter_email = $1
  `, [clientEmail.toLowerCase()]);

  if (clientResult.rows.length === 0) throw new Error(`Client not found: ${clientEmail}`);

  const { pharmacy_id, client_name } = clientResult.rows[0];
  console.log(`📦 Client: ${client_name}`);

  // Parse CSV
  console.log(`📄 Reading ${csvFilePath}...`);
  const rows = parseCSV(fs.readFileSync(csvFilePath, 'utf-8'));
  console.log(`   ${rows.length} records to process\n`);

  // PHASE 1: Collect unique patients
  console.log('👥 Phase 1: Processing patients...');
  const patientMap = new Map();

  for (const row of rows) {
    if (!row.patient_name) continue;

    const dob = parsePrimeRxDOB(row.patient_dob);
    const hash = generatePatientHash(row.patient_name, dob || '');
    const rxDate = parsePrimeRxDate(row.date_filled) || '1900-01-01';

    if (!patientMap.has(hash)) {
      const { firstName, lastName } = parsePrimeRxName(row.patient_name);

      patientMap.set(hash, {
        patient_id: uuidv4(),
        hash,
        first_name: firstName,
        last_name: lastName,
        dob: dob,
        insurance_bin: row.insurance_bin || null,
        insurance_group: row.group_number || null,
        most_recent_rx_date: rxDate,
        conditions: new Set(),
        prescriptions: [],
      });
    } else {
      const patient = patientMap.get(hash);
      if (rxDate > patient.most_recent_rx_date) {
        if (row.insurance_bin) patient.insurance_bin = row.insurance_bin;
        if (row.group_number) patient.insurance_group = row.group_number;
        patient.most_recent_rx_date = rxDate;
      }
    }

    const patient = patientMap.get(hash);
    const drugName = cleanDrugName(row.drug_name);
    if (drugName && !patient.prescriptions.includes(drugName)) {
      patient.prescriptions.push(drugName);
    }

    const conditions = inferConditions(row.therapeutic_class);
    conditions.forEach(c => patient.conditions.add(c));
  }

  console.log(`   Found ${patientMap.size} unique patients`);

  // Batch insert patients
  const patientBatches = [];
  let patientBatch = [];

  for (const [hash, patient] of patientMap) {
    patientBatch.push(patient);
    if (patientBatch.length >= BATCH_SIZE) {
      patientBatches.push(patientBatch);
      patientBatch = [];
    }
  }
  if (patientBatch.length > 0) patientBatches.push(patientBatch);

  let patientsInserted = 0;
  for (const batch of patientBatches) {
    const values = batch.map((p, i) => {
      const offset = i * 10;
      return `($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8}, $${offset+9}, $${offset+10})`;
    }).join(', ');

    const params = batch.flatMap(p => [
      p.patient_id,
      pharmacy_id,
      p.hash,
      p.first_name,
      p.last_name,
      p.dob,
      [...p.conditions],
      p.insurance_bin,
      p.insurance_group,
      JSON.stringify({ medications: p.prescriptions })
    ]);

    try {
      await pool.query(`
        INSERT INTO patients (patient_id, pharmacy_id, patient_hash, first_name, last_name, date_of_birth, chronic_conditions, primary_insurance_bin, primary_insurance_group, profile_data)
        VALUES ${values}
        ON CONFLICT (pharmacy_id, patient_hash)
        DO UPDATE SET
          first_name = COALESCE(EXCLUDED.first_name, patients.first_name),
          last_name = COALESCE(EXCLUDED.last_name, patients.last_name),
          chronic_conditions = EXCLUDED.chronic_conditions,
          primary_insurance_bin = EXCLUDED.primary_insurance_bin,
          primary_insurance_group = EXCLUDED.primary_insurance_group,
          profile_data = EXCLUDED.profile_data,
          updated_at = NOW()
      `, params);
      patientsInserted += batch.length;
      process.stdout.write(`   Inserted ${patientsInserted}/${patientMap.size} patients...\r`);
    } catch (err) {
      console.error(`\n   Batch error: ${err.message}`);
    }
  }
  console.log(`\n   ✅ ${patientsInserted} patients inserted`);

  // Fetch actual patient IDs from database
  console.log('   Fetching patient IDs from database...');
  const patientLookup = new Map();
  const patientResult = await pool.query(
    'SELECT patient_id, patient_hash FROM patients WHERE pharmacy_id = $1',
    [pharmacy_id]
  );
  for (const row of patientResult.rows) {
    patientLookup.set(row.patient_hash, row.patient_id);
  }
  console.log(`   Found ${patientLookup.size} patients in database`);

  // PHASE 2: Batch insert prescriptions
  console.log('\n💊 Phase 2: Processing prescriptions...');

  const rxBatches = [];
  let rxBatch = [];

  for (const row of rows) {
    if (!row.patient_name || !row.ndc) continue;

    const dob = parsePrimeRxDOB(row.patient_dob);
    const patientHash = generatePatientHash(row.patient_name, dob || '');
    const patientId = patientLookup.get(patientHash);
    if (!patientId) continue;

    const insurancePay = parseAmount(row.insurance_pay);
    const totalCost = parseAmount(row.total_cost);
    const grossProfit = insurancePay - totalCost;

    rxBatch.push({
      prescription_id: uuidv4(),
      pharmacy_id,
      patient_id: patientId,
      rx_number: row.rx_number,
      ndc: (row.ndc || '').replace(/-/g, ''),
      drug_name: cleanDrugName(row.drug_name),
      quantity: parseFloat(row.quantity) || 0,
      days_supply: parseInt(row.days_supply) || 30,
      dispensed_date: parsePrimeRxDate(row.date_filled) || new Date().toISOString().split('T')[0],
      insurance_bin: row.insurance_bin,
      insurance_group: row.group_number,
      patient_pay: 0, // Not in PrimeRx export
      insurance_pay: insurancePay,
      prescriber_name: row.prescriber_name ? row.prescriber_name.replace(/\./g, ', ') : null,
      daw_code: row.daw_code,
      raw_data: JSON.stringify({
        therapeutic_class: row.therapeutic_class,
        total_cost: totalCost,
        gross_profit: grossProfit,
        insurance_name: row.insurance_name,
        diag_code: row.diag_code,
      })
    });

    if (rxBatch.length >= BATCH_SIZE) {
      rxBatches.push(rxBatch);
      rxBatch = [];
    }
  }
  if (rxBatch.length > 0) rxBatches.push(rxBatch);

  // De-duplicate within file
  const seenRx = new Set();
  const dedupedBatches = [];
  let dedupedBatch = [];

  for (const batch of rxBatches) {
    for (const rx of batch) {
      const rxKey = `${rx.rx_number}|${rx.dispensed_date}`;
      if (seenRx.has(rxKey)) continue;
      seenRx.add(rxKey);
      dedupedBatch.push(rx);
      if (dedupedBatch.length >= BATCH_SIZE) {
        dedupedBatches.push(dedupedBatch);
        dedupedBatch = [];
      }
    }
  }
  if (dedupedBatch.length > 0) dedupedBatches.push(dedupedBatch);

  const totalDeduped = dedupedBatches.reduce((sum, b) => sum + b.length, 0);
  console.log(`   ${totalDeduped} unique prescriptions (${rows.length - totalDeduped} duplicates removed)`);

  let rxInserted = 0;
  let rxSkipped = 0;

  for (const batch of dedupedBatches) {
    const values = batch.map((rx, i) => {
      const o = i * 16;
      return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11},$${o+12},$${o+13},$${o+14},$${o+15},$${o+16})`;
    }).join(', ');

    const params = batch.flatMap(rx => [
      rx.prescription_id,
      rx.pharmacy_id,
      rx.patient_id,
      rx.rx_number,
      rx.ndc,
      rx.drug_name,
      rx.quantity,
      rx.days_supply,
      rx.dispensed_date,
      rx.insurance_bin,
      rx.insurance_group,
      rx.patient_pay,
      rx.insurance_pay,
      rx.prescriber_name,
      rx.daw_code,
      rx.raw_data
    ]);

    try {
      await pool.query(`
        INSERT INTO prescriptions (
          prescription_id, pharmacy_id, patient_id, rx_number, ndc, drug_name,
          quantity_dispensed, days_supply, dispensed_date, insurance_bin, insurance_group,
          patient_pay, insurance_pay, prescriber_name, daw_code, raw_data
        ) VALUES ${values}
        ON CONFLICT (pharmacy_id, rx_number, dispensed_date) DO UPDATE SET
          drug_name = EXCLUDED.drug_name,
          insurance_pay = EXCLUDED.insurance_pay,
          raw_data = EXCLUDED.raw_data
      `, params);
      rxInserted += batch.length;
    } catch (err) {
      rxSkipped += batch.length;
      console.error(`\n   Batch error: ${err.message}`);
    }

    process.stdout.write(`   Inserted ${rxInserted}/${totalDeduped} prescriptions...\r`);
  }

  console.log(`\n\n✅ Ingestion complete!`);
  console.log(`   📊 Records: ${rows.length}`);
  console.log(`   👥 Patients: ${patientsInserted}`);
  console.log(`   💊 Prescriptions: ${rxInserted}`);
  console.log(`   ⚠️  Skipped: ${rxSkipped}`);

  return { patients: patientsInserted, prescriptions: rxInserted };
}

// CLI
const args = process.argv.slice(2);
if (args.length < 2) {
  console.log('\nUsage: node ingest-primerx.js <client-email> <csv-file>\n');
  process.exit(1);
}

ingestData(args[0], args[1])
  .then(() => {
    console.log('\n🎉 Done! Run scanner to find opportunities.\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Failed:', err.message);
    process.exit(1);
  });
