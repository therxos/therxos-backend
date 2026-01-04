// TheRxOS V2 - FAST CSV Data Ingestion Script (Batch Mode)
// Run with: node ingest-fast.js <client-email> <csv-file-path>

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BATCH_SIZE = 500; // Insert 500 records at a time

// Column mapping
const COLUMN_MAP = {
  'Rx Number': 'rx_number',
  'Patient Full Name Last then First': 'patient_name',
  'Patient Date of Birth': 'patient_dob',
  'Patient Age': 'patient_age',
  'Date Written': 'date_written',
  'DAW Code': 'daw_code',
  'Dispensed Item Name': 'drug_name',
  'Dispensed Item NDC': 'ndc',
  'Dispensed Quantity': 'quantity',
  'Dispensing Unit': 'dispensing_unit',
  'Days Supply': 'days_supply',
  'Therapeutic Class Description': 'therapeutic_class',
  'PDC': 'pdc',
  'Dispensed AWP': 'awp',
  'Net Profit': 'net_profit',
  'Patient Paid Amount': 'patient_pay',
  'Primary Contract ID': 'contract_id',
  'Primary Prescription Benefit Plan': 'plan_name',
  'Primary': 'primary_flag',
  'Primary Third Party Bin': 'insurance_bin',
  'Primary Group Number': 'group_number',
  'Primary Network Reimbursement': 'insurance_pay',
  'Prescriber Full Name': 'prescriber_name',
  'Prescriber Fax Number': 'prescriber_fax',
};

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
  
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i], delimiter);
    const row = {};
    headers.forEach((header, index) => {
      const mappedKey = COLUMN_MAP[header] || header.toLowerCase().replace(/\s+/g, '_');
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

function parseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return dateStr;
}

function parseAmount(amountStr) {
  if (!amountStr) return 0;
  return parseFloat(String(amountStr).replace(/[$,]/g, '')) || 0;
}

function inferConditions(therapeuticClass) {
  const conditions = [];
  const tc = (therapeuticClass || '').toUpperCase();
  
  if (tc.includes('DIABETES') || tc.includes('INSULIN') || tc.includes('BIGUANIDE') || tc.includes('SULFONYLUREA')) conditions.push('Diabetes');
  if (tc.includes('ACE INHIBITOR') || tc.includes('ARB') || tc.includes('ANTIHYPERTENSIVE') || tc.includes('BETA BLOCKER') || tc.includes('CALCIUM CHANNEL')) conditions.push('Hypertension');
  if (tc.includes('STATIN') || tc.includes('CHOLESTEROL') || tc.includes('LIPID')) conditions.push('Hyperlipidemia');
  if (tc.includes('ANTIDEPRESSANT') || tc.includes('SSRI') || tc.includes('SNRI')) conditions.push('Depression');
  if (tc.includes('BRONCHODILATOR') || tc.includes('COPD') || tc.includes('ASTHMA')) conditions.push('COPD/Asthma');
  if (tc.includes('THYROID')) conditions.push('Thyroid');
  if (tc.includes('PROTON PUMP') || tc.includes('PPI') || tc.includes('GERD')) conditions.push('GERD');
  if (tc.includes('HIV')) conditions.push('HIV');
  
  return [...new Set(conditions)];
}

async function ingestData(clientEmail, csvFilePath) {
  console.log(`\n🚀 FAST ingestion for ${clientEmail}...\n`);
  
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
    const hash = generatePatientHash(row.patient_name, row.patient_dob || '');
    
    if (!patientMap.has(hash)) {
      patientMap.set(hash, {
        patient_id: uuidv4(),
        hash,
        dob: parseDate(row.patient_dob),
        insurance_bin: row.insurance_bin,
        group_number: row.group_number,
        conditions: new Set(),
      });
    }
    
    const conditions = inferConditions(row.therapeutic_class);
    conditions.forEach(c => patientMap.get(hash).conditions.add(c));
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
      const offset = i * 6;
      return `($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6})`;
    }).join(', ');
    
    const params = batch.flatMap(p => [
      p.patient_id,
      pharmacy_id,
      p.hash,
      p.dob,
      [...p.conditions],
      p.insurance_bin
    ]);
    
    try {
      await pool.query(`
        INSERT INTO patients (patient_id, pharmacy_id, patient_hash, date_of_birth, chronic_conditions, primary_insurance_bin)
        VALUES ${values}
        ON CONFLICT (pharmacy_id, patient_hash) DO UPDATE SET
          chronic_conditions = EXCLUDED.chronic_conditions
      `, params);
      patientsInserted += batch.length;
      process.stdout.write(`   Inserted ${patientsInserted}/${patientMap.size} patients...\r`);
    } catch (err) {
      console.error(`\n   Batch error: ${err.message}`);
    }
  }
  console.log(`\n   ✅ ${patientsInserted} patients inserted`);
  
  // IMPORTANT: Fetch actual patient IDs from database (in case they already existed)
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
    if (!row.patient_name || !row.ndc || !row.drug_name) continue;
    
    const patientHash = generatePatientHash(row.patient_name, row.patient_dob || '');
    const patientId = patientLookup.get(patientHash);
    if (!patientId) continue;
    
    rxBatch.push({
      prescription_id: uuidv4(),
      pharmacy_id,
      patient_id: patientId,
      rx_number: row.rx_number,
      ndc: (row.ndc || '').replace(/-/g, ''),
      drug_name: row.drug_name,
      quantity: parseFloat(row.quantity) || 0,
      days_supply: parseInt(row.days_supply) || 30,
      dispensed_date: parseDate(row.date_written) || new Date().toISOString().split('T')[0],
      insurance_bin: row.insurance_bin,
      insurance_group: row.group_number,
      patient_pay: parseAmount(row.patient_pay),
      insurance_pay: parseAmount(row.insurance_pay),
      prescriber_name: row.prescriber_name,
      daw_code: row.daw_code,
      raw_data: JSON.stringify({
        therapeutic_class: row.therapeutic_class,
        pdc: row.pdc,
        awp: parseAmount(row.awp),
        net_profit: parseAmount(row.net_profit),
        plan_name: row.plan_name
      })
    });
    
    if (rxBatch.length >= BATCH_SIZE) {
      rxBatches.push(rxBatch);
      rxBatch = [];
    }
  }
  if (rxBatch.length > 0) rxBatches.push(rxBatch);
  
  let rxInserted = 0;
  let rxSkipped = 0;
  
  // De-duplicate within file first
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
  console.log('\nUsage: node ingest-fast.js <client-email> <csv-file>\n');
  process.exit(1);
}

ingestData(args[0], args[1])
  .then(() => {
    console.log('\n🎉 Done! Run scanner: node run-scanner.js ' + args[0] + '\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Failed:', err.message);
    process.exit(1);
  });
