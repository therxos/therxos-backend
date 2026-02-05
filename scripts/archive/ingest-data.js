// TheRxOS V2 - CSV Data Ingestion Script
// Run with: node ingest-data.js <client-email> <csv-file-path>
// Example: node ingest-data.js contact@mybravorx.com ./bravo-data.csv

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ============================================
// COLUMN MAPPING - Supports PioneerRx & RX30
// ============================================
const COLUMN_MAP = {
  // PioneerRx Format
  'Rx Number': 'rx_number',
  'Date Filled': 'dispensed_date',
  'Primary Third Party PCN': 'insurance_pcn',
  'Patient Full Name Last then First': 'patient_name',
  'Patient Full Name': 'patient_name',
  'Patient First Name': 'patient_first_name',
  'Patient Last Name': 'patient_last_name',
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
  'Prescriber First Name': 'prescriber_first_name',
  'Prescriber Last Name': 'prescriber_last_name',
  'Prescriber Fax Number': 'prescriber_fax',

  // RX30 Format
  'Fill Date': 'dispensed_date',
  'Refill Number': 'refill_number',
  'Customer Name': 'patient_name',
  'Date of Birth': 'patient_dob',
  'Drug Name': 'drug_name',
  'NDC': 'ndc',
  'DEA Class': 'dea_class',
  'Quantity Dispensed': 'quantity',
  'Price': 'awp',
  'Plan Paid Amount - Total': 'insurance_pay',
  'Patient Pay Amount': 'patient_pay',
  'Total Paid': 'total_paid',
  'Actual Cost': 'acquisition_cost',
  'Gross Profit': 'gross_profit',
  'Written Date': 'date_written',
  'Delivered Date': 'delivered_date',
  'Plan ID': 'plan_name',
  'PCN': 'insurance_pcn',
  'BIN': 'insurance_bin',
  'Prescriber Name': 'prescriber_name',

  // Aracoma/PMS Format
  'TransactionDateKey': 'dispensed_date',
  'RxRefill': 'rx_number',
  'DrugName': 'drug_name',
  'FormulationType': 'formulary_type',
  'DrugGroup': 'therapeutic_class',
  'DrugClass': 'drug_class',
  'GroupNumber': 'group_number',
  'ClaimAmountPaid': 'insurance_pay',
  'CopayPaid': 'patient_pay',
  'Revenue': 'total_paid',
  'AdjustedContractCost2': 'acquisition_cost',
  'AdjProfit3': 'gross_profit',
  'AdjGPM': 'gross_profit_margin',
  'PatientName': 'patient_name',
  'PatientBirthdate': 'patient_dob',
  'PrescriberName': 'prescriber_name',
  'PrescriberID': 'prescriber_npi',
};
// Case-insensitive lookup version
const COLUMN_MAP_LOWER = Object.fromEntries(
  Object.entries(COLUMN_MAP).map(([k, v]) => [k.toLowerCase(), v])
);

// Parse CSV (auto-detect delimiter)
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const firstLine = lines[0];
  
  // Auto-detect delimiter (comma or tab)
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  console.log(`   Detected delimiter: ${delimiter === '\t' ? 'TAB' : 'COMMA'}`);
  
  // Parse headers - handle quoted fields
  const headers = parseCSVLine(firstLine, delimiter);
  console.log(`   Found ${headers.length} columns`);
  console.log(`   First 3 columns: ${headers.slice(0, 3).join(', ')}`);
  
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    
    const values = parseCSVLine(lines[i], delimiter);
    const row = {};
    headers.forEach((header, index) => {
      const cleanHeader = header.trim();
      const mappedKey = COLUMN_MAP[cleanHeader] || COLUMN_MAP_LOWER[cleanHeader.toLowerCase()] || cleanHeader.toLowerCase().replace(/\s+/g, '_');
      row[mappedKey] = values[index]?.trim() || null;
    });
    rows.push(row);
  }
  
  return rows;
}

// Parse a single CSV line handling quoted fields
function parseCSVLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  
  return result;
}

// Generate patient hash from name and DOB (or Rx number if no name)
function generatePatientHash(name, dob, rxNumber = null) {
  // If no patient name, use Rx number as identifier
  if (!name && rxNumber) {
    return createHash('sha256').update(`rx:${rxNumber}`).digest('hex');
  }
  // Parse name (format: "Last, First" or "Last(BP), First")
  const cleanName = (name || 'UNKNOWN').replace(/\([^)]*\)/g, '').trim();
  const normalized = `${cleanName}|${dob || ''}`.toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

// Parse date from various formats
function parseDate(dateStr) {
  if (!dateStr) return null;

  // Strip time portion if present (e.g., "10/6/2025 9:44 AM" -> "10/6/2025")
  const dateOnly = dateStr.split(' ')[0];

  // Handle MM/DD/YYYY format
  const parts = dateOnly.split('/');
  if (parts.length === 3) {
    const [month, day, year] = parts;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return dateStr;
}

// Parse currency amount
function parseAmount(amountStr) {
  if (!amountStr) return 0;
  return parseFloat(amountStr.replace(/[$,]/g, '')) || 0;
}

// Pad BIN to 6 digits (standard format)
function padBin(bin) {
  if (!bin) return null;
  const cleaned = bin.toString().replace(/\D/g, '');
  return cleaned.padStart(6, '0');
}

// Parse patient name and return first 3 letters of first/last for privacy
function parsePatientName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };

  // Clean up the name - remove suffixes like (BP), Jr, etc
  const cleanName = fullName.replace(/\([^)]*\)/g, '').replace(/\s+(jr|sr|ii|iii|iv)\.?$/i, '').trim();

  let firstName = '';
  let lastName = '';

  if (cleanName.includes(',')) {
    // Format: "Last, First" or "Last, First Middle"
    const parts = cleanName.split(',').map(p => p.trim());
    lastName = parts[0] || '';
    firstName = (parts[1] || '').split(/\s+/)[0] || ''; // First word after comma
  } else {
    // Format: "First Last" or "First Middle Last"
    const parts = cleanName.split(/\s+/);
    if (parts.length >= 2) {
      firstName = parts[0] || '';
      lastName = parts[parts.length - 1] || ''; // Last word is last name
    } else {
      lastName = parts[0] || '';
    }
  }

  // Return first 3 letters of each, uppercase
  return {
    firstName: firstName.substring(0, 3).toUpperCase() || null,
    lastName: lastName.substring(0, 3).toUpperCase() || null
  };
}

// Extract chronic conditions from therapeutic classes
function inferConditions(therapeuticClass) {
  const conditions = [];
  const tc = (therapeuticClass || '').toUpperCase();
  
  if (tc.includes('DIABETES') || tc.includes('INSULIN') || tc.includes('BIGUANIDE') || tc.includes('SULFONYLUREA')) {
    conditions.push('Diabetes');
  }
  if (tc.includes('ACE INHIBITOR') || tc.includes('ARB') || tc.includes('ANTIHYPERTENSIVE') || tc.includes('BETA BLOCKER') || tc.includes('CALCIUM CHANNEL')) {
    conditions.push('Hypertension');
  }
  if (tc.includes('STATIN') || tc.includes('CHOLESTEROL') || tc.includes('LIPID')) {
    conditions.push('Hyperlipidemia');
  }
  if (tc.includes('ANTIDEPRESSANT') || tc.includes('SSRI') || tc.includes('SNRI')) {
    conditions.push('Depression');
  }
  if (tc.includes('BRONCHODILATOR') || tc.includes('COPD') || tc.includes('ASTHMA')) {
    conditions.push('COPD/Asthma');
  }
  if (tc.includes('ANTICOAGULANT') || tc.includes('BLOOD THINNER')) {
    conditions.push('CVD');
  }
  if (tc.includes('THYROID')) {
    conditions.push('Thyroid');
  }
  if (tc.includes('PROTON PUMP') || tc.includes('PPI') || tc.includes('GERD')) {
    conditions.push('GERD');
  }
  if (tc.includes('HIV')) {
    conditions.push('HIV');
  }
  
  return [...new Set(conditions)];
}

// ============================================
// BATCH SIZE FOR INSERTS
// ============================================
const BATCH_SIZE = 50; // Reduced to avoid rate limits

// Small delay between batches to avoid rate limits
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// MAIN INGESTION FUNCTION (OPTIMIZED WITH BATCHING)
// ============================================
async function ingestData(clientEmail, csvFilePath) {
  console.log(`\n🚀 Starting data ingestion for ${clientEmail}...\n`);
  const startTime = Date.now();

  // Get client and pharmacy info
  const clientResult = await pool.query(`
    SELECT c.client_id, p.pharmacy_id, c.client_name
    FROM clients c
    JOIN pharmacies p ON p.client_id = c.client_id
    WHERE c.submitter_email = $1
  `, [clientEmail.toLowerCase()]);

  if (clientResult.rows.length === 0) {
    throw new Error(`Client not found: ${clientEmail}`);
  }

  const { client_id, pharmacy_id, client_name } = clientResult.rows[0];
  console.log(`📦 Found client: ${client_name}`);
  console.log(`   Pharmacy ID: ${pharmacy_id}\n`);

  // Read and parse CSV
  console.log(`📄 Reading CSV file: ${csvFilePath}`);
  const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
  const rows = parseCSV(csvContent);
  console.log(`   Found ${rows.length} prescription records\n`);

  // ========== PHASE 1: Build patient map in memory ==========
  console.log('👥 Phase 1: Building patient data...');
  const patientMap = new Map(); // hash -> { patientId, firstName, lastName, dob, conditions, bin, pcn }
  let skipped = 0;

  for (const row of rows) {
    // Require drug name (NDC optional), patient_name is optional if rx_number exists
    if (!row.drug_name) {
      skipped++;
      continue;
    }
    // Build patient name from separate columns if needed
    const patientName = row.patient_name ||
      (row.patient_last_name && row.patient_first_name ? `${row.patient_last_name}, ${row.patient_first_name}` :
       row.patient_last_name || row.patient_first_name || null);

    if (!patientName && !row.rx_number) {
      skipped++;
      continue;
    }

    const patientHash = generatePatientHash(patientName, row.patient_dob || '', row.rx_number);

    if (patientMap.has(patientHash)) {
      // Merge conditions
      const existing = patientMap.get(patientHash);
      const newConditions = inferConditions(row.therapeutic_class);
      existing.conditions = [...new Set([...existing.conditions, ...newConditions])];
    } else {
      // Use separate first/last columns if available, otherwise parse combined name
      let firstName, lastName;
      if (row.patient_first_name || row.patient_last_name) {
        firstName = row.patient_first_name || null;
        lastName = row.patient_last_name || null;
      } else if (patientName) {
        const parsed = parsePatientName(patientName);
        firstName = parsed.firstName;
        lastName = parsed.lastName;
      } else {
        firstName = null;
        lastName = null;
      }
      patientMap.set(patientHash, {
        patientId: uuidv4(),
        patientHash,
        firstName,
        lastName,
        dob: parseDate(row.patient_dob),
        conditions: inferConditions(row.therapeutic_class),
        bin: padBin(row.insurance_bin),
        pcn: row.group_number
      });
    }
  }
  console.log(`   Found ${patientMap.size} unique patients\n`);

  // ========== PHASE 2: Batch upsert patients ==========
  console.log('👥 Phase 2: Inserting patients in batches...');
  const patientArray = Array.from(patientMap.values());
  let patientCount = 0;

  for (let i = 0; i < patientArray.length; i += BATCH_SIZE) {
    const batch = patientArray.slice(i, i + BATCH_SIZE);

    // Build multi-row INSERT
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const p of batch) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(p.patientId, pharmacy_id, p.patientHash, p.firstName, p.lastName, p.dob, p.conditions, p.bin, p.pcn);
    }

    await pool.query(`
      INSERT INTO patients (patient_id, pharmacy_id, patient_hash, first_name, last_name, date_of_birth, chronic_conditions, primary_insurance_bin, primary_insurance_pcn)
      VALUES ${values.join(', ')}
      ON CONFLICT ON CONSTRAINT patients_patient_hash_key DO UPDATE SET
        first_name = COALESCE(EXCLUDED.first_name, patients.first_name),
        last_name = COALESCE(EXCLUDED.last_name, patients.last_name),
        chronic_conditions = EXCLUDED.chronic_conditions,
        primary_insurance_bin = EXCLUDED.primary_insurance_bin,
        primary_insurance_pcn = EXCLUDED.primary_insurance_pcn,
        updated_at = NOW()
    `, params);

    patientCount += batch.length;
    process.stdout.write(`   Inserted ${patientCount}/${patientArray.length} patients...\r`);
    await delay(50); // Brief pause to avoid rate limits
  }

  // Get actual patient IDs from DB (in case of conflicts)
  const patientIdResult = await pool.query(
    'SELECT patient_id, patient_hash FROM patients WHERE pharmacy_id = $1',
    [pharmacy_id]
  );
  const hashToId = new Map();
  for (const row of patientIdResult.rows) {
    hashToId.set(row.patient_hash, row.patient_id);
  }
  console.log(`\n   ✓ ${patientCount} patients processed\n`);

  // ========== PHASE 3: Batch upsert prescriptions ==========
  console.log('💊 Phase 3: Inserting prescriptions in batches...');
  let rxCount = 0;
  let rxBatch = [];

  for (const row of rows) {
    if (!row.drug_name) continue;

    // Build patient name from separate columns if needed
    const patientName = row.patient_name ||
      (row.patient_last_name && row.patient_first_name ? `${row.patient_last_name}, ${row.patient_first_name}` :
       row.patient_last_name || row.patient_first_name || null);

    if (!patientName && !row.rx_number) continue;

    const patientHash = generatePatientHash(patientName, row.patient_dob || '', row.rx_number);
    const patientId = hashToId.get(patientHash);
    if (!patientId) continue;

    const dispensedDate = parseDate(row.dispensed_date) || parseDate(row.date_written) || new Date().toISOString().split('T')[0];

    rxBatch.push({
      prescription_id: uuidv4(),
      pharmacy_id,
      patient_id: patientId,
      rx_number: row.rx_number,
      ndc: row.ndc?.replace(/-/g, ''),
      drug_name: row.drug_name,
      quantity: parseFloat(row.quantity) || parseFloat(row.quantity_dispensed) || 0,
      days_supply: parseInt(row.days_supply) || 30,
      dispensed_date: dispensedDate,
      insurance_bin: padBin(row.insurance_bin),
      insurance_group: row.group_number || row.insurance_pcn,
      patient_pay: parseAmount(row.patient_pay),
      insurance_pay: parseAmount(row.insurance_pay),
      acquisition_cost: parseAmount(row.acquisition_cost) || 0,
      prescriber_name: row.prescriber_name || (row.prescriber_first_name && row.prescriber_last_name ? `${row.prescriber_last_name}, ${row.prescriber_first_name}` : row.prescriber_last_name || row.prescriber_first_name || null),
      daw_code: row.daw_code,
      raw_data: JSON.stringify({
        therapeutic_class: row.therapeutic_class,
        pdc: row.pdc,
        awp: parseAmount(row.awp),
        net_profit: parseAmount(row.net_profit),
        gross_profit: parseAmount(row.gross_profit),
        plan_name: row.plan_name,
        total_paid: parseAmount(row.total_paid)
      })
    });

    // Flush batch when full
    if (rxBatch.length >= BATCH_SIZE) {
      await insertPrescriptionBatch(rxBatch);
      rxCount += rxBatch.length;
      process.stdout.write(`   Inserted ${rxCount} prescriptions...\r`);
      rxBatch = [];
      await delay(50); // Brief pause to avoid rate limits
    }
  }

  // Flush remaining
  if (rxBatch.length > 0) {
    await insertPrescriptionBatch(rxBatch);
    rxCount += rxBatch.length;
  }
  console.log(`\n   ✓ ${rxCount} prescriptions processed\n`);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`⏱️  Total time: ${elapsed} seconds\n`);

  return { rxCount, patients: patientMap.size, skipped };
}

// Helper function for batch prescription insert
async function insertPrescriptionBatch(batch) {
  // De-duplicate batch by (pharmacy_id, rx_number, dispensed_date) - keep last occurrence
  const seen = new Map();
  for (const rx of batch) {
    const key = `${rx.pharmacy_id}|${rx.rx_number}|${rx.dispensed_date}`;
    seen.set(key, rx);
  }
  const dedupedBatch = Array.from(seen.values());

  const values = [];
  const params = [];
  let paramIdx = 1;

  for (const rx of dedupedBatch) {
    values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
    params.push(
      rx.prescription_id, rx.pharmacy_id, rx.patient_id, rx.rx_number, rx.ndc, rx.drug_name,
      rx.quantity, rx.days_supply, rx.dispensed_date, rx.insurance_bin, rx.insurance_group,
      rx.patient_pay, rx.insurance_pay, rx.acquisition_cost, rx.prescriber_name, rx.daw_code,
      'csv_upload', rx.raw_data
    );
  }

  await pool.query(`
    INSERT INTO prescriptions (
      prescription_id, pharmacy_id, patient_id, rx_number, ndc, drug_name,
      quantity_dispensed, days_supply, dispensed_date, insurance_bin, insurance_group,
      patient_pay, insurance_pay, acquisition_cost, prescriber_name, daw_code, source, raw_data
    ) VALUES ${values.join(', ')}
    ON CONFLICT (pharmacy_id, rx_number, dispensed_date) DO UPDATE SET
      drug_name = EXCLUDED.drug_name,
      quantity_dispensed = EXCLUDED.quantity_dispensed,
      patient_pay = EXCLUDED.patient_pay,
      insurance_pay = EXCLUDED.insurance_pay,
      acquisition_cost = EXCLUDED.acquisition_cost,
      raw_data = EXCLUDED.raw_data
  `, params);
}

// ============================================
// CLI INTERFACE
// ============================================
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('\nUsage: node ingest-data.js <client-email> <csv-file-path>\n');
  console.log('Example:');
  console.log('  node ingest-data.js contact@mybravorx.com ./bravo-data.csv');
  console.log('  node ingest-data.js michaelbakerrph@gmail.com ./aracoma-data.csv\n');
  process.exit(1);
}

const [clientEmail, csvPath] = args;

if (!fs.existsSync(csvPath)) {
  console.error(`\n❌ File not found: ${csvPath}\n`);
  process.exit(1);
}

ingestData(clientEmail, csvPath)
  .then(() => {
    console.log('\n🎉 Done! Now run the opportunity scanner:\n');
    console.log(`   node run-scanner.js ${clientEmail}\n`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Ingestion failed:', err.message);
    process.exit(1);
  });
