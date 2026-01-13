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
};

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
      const mappedKey = COLUMN_MAP[cleanHeader] || cleanHeader.toLowerCase().replace(/\s+/g, '_');
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

// Generate patient hash from name and DOB
function generatePatientHash(name, dob) {
  // Parse name (format: "Last, First" or "Last(BP), First")
  const cleanName = name.replace(/\([^)]*\)/g, '').trim();
  const normalized = `${cleanName}|${dob}`.toLowerCase();
  return createHash('sha256').update(normalized).digest('hex');
}

// Parse date from various formats
function parseDate(dateStr) {
  if (!dateStr) return null;
  
  // Handle MM/DD/YYYY format
  const parts = dateStr.split('/');
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
// MAIN INGESTION FUNCTION
// ============================================
async function ingestData(clientEmail, csvFilePath) {
  console.log(`\n🚀 Starting data ingestion for ${clientEmail}...\n`);
  
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
  
  // Track patients and stats
  const patients = new Map();
  let rxCount = 0;
  let skipped = 0;
  
  // Process each row
  console.log('💊 Processing prescriptions...');
  
  for (const row of rows) {
    try {
      // Skip if missing required fields
      if (!row.patient_name || !row.ndc || !row.drug_name) {
        skipped++;
        if (skipped <= 3) {
          console.log(`   Skipped: missing required field - name:${!!row.patient_name} ndc:${!!row.ndc} drug:${!!row.drug_name}`);
        }
        continue;
      }
      
      // Generate patient hash
      const patientHash = generatePatientHash(row.patient_name, row.patient_dob || '');
      
      // Get or create patient
      let patientId;
      if (patients.has(patientHash)) {
        patientId = patients.get(patientHash).patientId;
        // Update conditions
        const existingConditions = patients.get(patientHash).conditions;
        const newConditions = inferConditions(row.therapeutic_class);
        patients.get(patientHash).conditions = [...new Set([...existingConditions, ...newConditions])];
      } else {
        // Check if patient exists in DB
        const existingPatient = await pool.query(
          'SELECT patient_id, chronic_conditions FROM patients WHERE patient_hash = $1 AND pharmacy_id = $2',
          [patientHash, pharmacy_id]
        );
        
        if (existingPatient.rows.length > 0) {
          patientId = existingPatient.rows[0].patient_id;
          const existingConditions = existingPatient.rows[0].chronic_conditions || [];
          patients.set(patientHash, { 
            patientId, 
            conditions: [...new Set([...existingConditions, ...inferConditions(row.therapeutic_class)])]
          });
        } else {
          patientId = uuidv4();
          const conditions = inferConditions(row.therapeutic_class);
          const { firstName, lastName } = parsePatientName(row.patient_name);

          const result = await pool.query(`
            INSERT INTO patients (
              patient_id, pharmacy_id, patient_hash, first_name, last_name, date_of_birth,
              chronic_conditions, primary_insurance_bin, primary_insurance_pcn
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT ON CONSTRAINT patients_patient_hash_key DO UPDATE SET
              first_name = COALESCE(EXCLUDED.first_name, patients.first_name),
              last_name = COALESCE(EXCLUDED.last_name, patients.last_name),
              chronic_conditions = EXCLUDED.chronic_conditions,
              primary_insurance_bin = EXCLUDED.primary_insurance_bin,
              primary_insurance_pcn = EXCLUDED.primary_insurance_pcn,
              updated_at = NOW()
            RETURNING patient_id
          `, [
            patientId,
            pharmacy_id,
            patientHash,
            firstName,
            lastName,
            parseDate(row.patient_dob),
            conditions,
            padBin(row.insurance_bin),
            row.group_number
          ]);
          patientId = result.rows[0].patient_id;

          patients.set(patientHash, { patientId, conditions });
        }
      }
      
      // Insert prescription (upsert based on rx_number)
      // RX30 uses Fill Date -> dispensed_date, PioneerRx uses Date Written -> date_written
      const dispensedDate = parseDate(row.dispensed_date) || parseDate(row.date_written) || new Date().toISOString().split('T')[0];

      await pool.query(`
        INSERT INTO prescriptions (
          prescription_id, pharmacy_id, patient_id, rx_number, ndc, drug_name,
          quantity_dispensed, days_supply, dispensed_date,
          insurance_bin, insurance_group,
          patient_pay, insurance_pay, acquisition_cost,
          prescriber_name, daw_code, source, raw_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (pharmacy_id, rx_number, dispensed_date) DO UPDATE SET
          drug_name = EXCLUDED.drug_name,
          quantity_dispensed = EXCLUDED.quantity_dispensed,
          patient_pay = EXCLUDED.patient_pay,
          insurance_pay = EXCLUDED.insurance_pay,
          acquisition_cost = EXCLUDED.acquisition_cost,
          raw_data = EXCLUDED.raw_data
      `, [
        uuidv4(),
        pharmacy_id,
        patientId,
        row.rx_number,
        row.ndc?.replace(/-/g, ''),
        row.drug_name,
        parseFloat(row.quantity) || parseFloat(row.quantity_dispensed) || 0,
        parseInt(row.days_supply) || 30,
        dispensedDate,
        padBin(row.insurance_bin),
        row.group_number || row.insurance_pcn,
        parseAmount(row.patient_pay),
        parseAmount(row.insurance_pay),
        parseAmount(row.acquisition_cost) || 0,
        row.prescriber_name,
        row.daw_code,
        'csv_upload',
        JSON.stringify({
          therapeutic_class: row.therapeutic_class,
          pdc: row.pdc,
          awp: parseAmount(row.awp),
          net_profit: parseAmount(row.net_profit),
          gross_profit: parseAmount(row.gross_profit),
          plan_name: row.plan_name,
          total_paid: parseAmount(row.total_paid)
        })
      ]);
      
      rxCount++;
      
      if (rxCount % 100 === 0) {
        process.stdout.write(`   Processed ${rxCount} prescriptions...\r`);
      }
      
    } catch (error) {
      if (skipped < 5) {
        console.error(`   Error processing row: ${error.message}`);
      }
      skipped++;
    }
  }
  
  // Update patient conditions
  console.log('\n\n👥 Updating patient conditions...');
  for (const [hash, data] of patients) {
    if (data.conditions.length > 0) {
      await pool.query(
        'UPDATE patients SET chronic_conditions = $1 WHERE patient_id = $2',
        [data.conditions, data.patientId]
      );
    }
  }
  
  // Log ingestion
  try {
    await pool.query(`
      INSERT INTO ingestion_logs (
        log_id, pharmacy_id, source_type, file_name,
        records_received, records_processed, records_failed, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      uuidv4(),
      pharmacy_id,
      'csv_upload',
      path.basename(csvFilePath),
      rows.length,
      rxCount,
      skipped,
      'completed'
    ]);
  } catch (logError) {
    // Ingestion log table might have different schema, skip logging
    console.log('   (Skipped ingestion log - table schema mismatch)');
  }
  
  console.log(`\n✅ Ingestion complete!`);
  console.log(`   📊 Total records: ${rows.length}`);
  console.log(`   ✓ Processed: ${rxCount}`);
  console.log(`   ✗ Skipped: ${skipped}`);
  console.log(`   👥 Unique patients: ${patients.size}`);
  
  return { rxCount, patients: patients.size, skipped };
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
