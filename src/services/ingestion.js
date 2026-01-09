// CSV Ingestion Service for TheRxOS V2
// Handles parsing, validation, client routing, and database insertion

import { parse } from 'csv-parse';
import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

/**
 * Column mappings for different PMS systems
 * Maps PMS-specific column names to our standardized schema
 */
const PMS_COLUMN_MAPPINGS = {
  // Pioneer SPP Report format (nightly scheduled report)
  spp: {
    rx_number: ['RxNumber', 'Rx Number', 'RX_NUM'],
    ndc: ['NDC'],
    drug_name: ['Medication', 'Drug Name', 'DrugName'],
    quantity_dispensed: ['Quantity', 'Qty'],
    days_supply: ['DaySupply', 'Days Supply', 'DaysSupply'],
    daw_code: ['DAW', 'DAW Code'],
    prescriber_npi: ['PresNPI', 'Prescriber NPI', 'PrescriberNPI'],
    prescriber_name: ['PresLastName', 'PresFirstName'], // Will be combined
    prescriber_first: ['PresFirstName'],
    prescriber_last: ['PresLastName'],
    patient_first: ['PatFirstName', 'Patient First', 'FirstName'],
    patient_last: ['PatLastName', 'Patient Last', 'LastName'],
    patient_dob: ['PatDOB', 'DOB', 'Date of Birth'],
    patient_zip: ['PatZip', 'Zip', 'ZIP'],
    patient_phone: ['PatPhone', 'Phone'],
    patient_address: ['PatAddr1', 'Address'],
    patient_city: ['PatCity', 'City'],
    patient_state: ['PatState', 'State'],
    patient_gender: ['PatGender', 'Gender'],
    insurance_bin: ['Primary_PBM_BIN', 'BIN', 'Insurance BIN'],
    insurance_pcn: ['PCN', 'Insurance PCN'],
    insurance_group: ['Group', 'Insurance Group'],
    payer_name: ['Primary_PayerName', 'Payer Name', 'Insurance'],
    payer_type: ['Primary_PayerType', 'Payer Type'],
    coverage_type: ['Primary_CoverageType', 'Coverage Type'],
    dispensed_date: ['RefDate', 'RecDate', 'Fill Date', 'Dispensed Date'],
    status_code: ['StatusCode', 'Status'],
    status_date: ['StatusDate'],
    pharmacy_npi: ['PharmNPI', 'Pharmacy NPI'],
    rx_fill: ['RxFill', 'Fill Number'],
    unit_measure: ['UnitMeasure', 'Unit']
  },
  pioneerrx: {
    rx_number: ['Rx Number', 'RxNumber', 'RX_NUM'],
    ndc: ['NDC', 'NDC11', 'Product NDC', 'Dispensed Item NDC'],
    drug_name: ['Drug Name', 'DrugName', 'Medication', 'Dispensed Item Name'],
    quantity_dispensed: ['Qty', 'Quantity', 'Qty Dispensed', 'QuantityDispensed', 'Dispensed Quantity'],
    days_supply: ['Days Supply', 'DaysSupply', 'Days'],
    daw_code: ['DAW', 'DAW Code', 'DAWCode'],
    prescriber_npi: ['Prescriber NPI', 'PrescriberNPI', 'Doctor NPI'],
    prescriber_name: ['Prescriber', 'Prescriber Name', 'Doctor', 'Prescriber Full Name'],
    patient_first: ['Patient First', 'FirstName', 'Patient First Name'],
    patient_last: ['Patient Last', 'LastName', 'Patient Last Name'],
    patient_full_name: ['Patient Full Name', 'Patient Name', 'PatientName'],
    patient_dob: ['DOB', 'Date of Birth', 'BirthDate'],
    patient_zip: ['Zip', 'ZIP', 'Patient Zip'],
    insurance_bin: ['BIN', 'Insurance BIN', 'Ins BIN', 'Primary Third Party Bin'],
    insurance_pcn: ['PCN', 'Insurance PCN', 'Ins PCN', 'Primary Third Party PCN'],
    insurance_group: ['Group', 'Insurance Group', 'Group ID', 'GroupID', 'Primary Group Number'],
    patient_pay: ['Patient Pay', 'Copay', 'Patient Cost', 'PatientPay', 'Primary Copay Amount', 'Patient Paid Amount'],
    insurance_pay: ['Insurance Pay', 'Ins Pay', 'Third Party Pay'],
    acquisition_cost: ['ACQ', 'Acquisition Cost', 'Cost'],
    gross_profit: ['Gross Profit', 'GP', 'Profit'],
    sig: ['SIG', 'Directions', 'Instructions'],
    dispensed_date: ['Fill Date', 'Dispensed Date', 'Date Filled', 'DateFilled'],
    written_date: ['Written Date', 'Rx Date', 'DateWritten'],
    refills_remaining: ['Refills', 'Refills Remaining', 'RefillsLeft']
  },
  rx30: {
    // Similar mappings for Rx30
    rx_number: ['RX_NO', 'Rx No', 'Script Number'],
    ndc: ['NDC_UPC', 'NDC', 'Product'],
    drug_name: ['DRUG_NAME', 'Drug', 'Med Name'],
    quantity_dispensed: ['QTY_DISP', 'Quantity', 'Qty'],
    // ... add more Rx30 specific mappings
  },
  generic: {
    // Fallback generic mappings
    rx_number: ['rx_number', 'rx', 'prescription_number'],
    ndc: ['ndc', 'ndc11', 'product_ndc'],
    drug_name: ['drug_name', 'medication', 'drug'],
    quantity_dispensed: ['quantity', 'qty', 'quantity_dispensed'],
    days_supply: ['days_supply', 'days', 'supply_days'],
    daw_code: ['daw', 'daw_code'],
    prescriber_npi: ['prescriber_npi', 'doctor_npi', 'npi'],
    prescriber_name: ['prescriber_name', 'prescriber', 'doctor'],
    patient_first: ['patient_first', 'first_name'],
    patient_last: ['patient_last', 'last_name'],
    patient_dob: ['dob', 'date_of_birth', 'birth_date'],
    insurance_bin: ['bin', 'insurance_bin'],
    insurance_pcn: ['pcn', 'insurance_pcn'],
    insurance_group: ['group', 'insurance_group', 'group_id'],
    patient_pay: ['patient_pay', 'copay'],
    insurance_pay: ['insurance_pay', 'ins_pay'],
    acquisition_cost: ['acquisition_cost', 'cost', 'acq'],
    sig: ['sig', 'directions'],
    dispensed_date: ['dispensed_date', 'fill_date', 'date'],
    written_date: ['written_date', 'rx_date'],
    refills_remaining: ['refills', 'refills_remaining']
  }
};

/**
 * Detect delimiter from first line of file
 */
function detectDelimiter(buffer) {
  const firstLine = buffer.toString('utf8').split('\n')[0];
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g) || []).length;

  // If more tabs than commas, it's TSV
  return tabCount > commaCount ? '\t' : ',';
}

/**
 * Parse CSV buffer into records
 */
async function parseCSV(buffer, options = {}) {
  const delimiter = detectDelimiter(buffer);

  return new Promise((resolve, reject) => {
    const records = [];
    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      delimiter: delimiter,
      ...options
    });

    parser.on('readable', () => {
      let record;
      while ((record = parser.read()) !== null) {
        records.push(record);
      }
    });

    parser.on('error', (err) => reject(err));
    parser.on('end', () => resolve(records));

    parser.write(buffer);
    parser.end();
  });
}

/**
 * Detect PMS system from CSV headers
 */
function detectPMSSystem(headers) {
  const headerSet = new Set(headers.map(h => h.toLowerCase().trim()));

  // Check for SPP Report format (Pioneer nightly export)
  // SPP has unique columns like PatLastName, PatFirstName, PresNPI, Primary_PBM_BIN
  if (headerSet.has('patlastname') || headerSet.has('patfirstname') ||
      headerSet.has('presnpi') || headerSet.has('primary_pbm_bin') ||
      headerSet.has('refdate') || headerSet.has('recdate')) {
    return 'spp';
  }

  // Check for PioneerRx-specific columns
  if (headerSet.has('rx number') || headerSet.has('rxnumber')) {
    return 'pioneerrx';
  }

  // Check for Rx30-specific columns
  if (headerSet.has('rx_no') || headerSet.has('script number')) {
    return 'rx30';
  }

  return 'generic';
}

/**
 * Map a column name to our standardized field
 */
function findColumnValue(row, fieldMappings) {
  // Handle undefined or non-array mappings
  if (!fieldMappings || !Array.isArray(fieldMappings)) {
    return null;
  }

  for (const possibleName of fieldMappings) {
    // Try exact match
    if (row[possibleName] !== undefined) {
      return row[possibleName];
    }
    // Try case-insensitive match
    const lowerName = possibleName.toLowerCase();
    for (const [key, value] of Object.entries(row)) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Normalize NDC to 11-digit format
 */
function normalizeNDC(ndc) {
  if (!ndc) return null;
  
  // Remove dashes, spaces, and non-numeric characters
  const cleaned = ndc.toString().replace(/[^0-9]/g, '');
  
  // Pad to 11 digits if needed
  if (cleaned.length === 10) {
    return '0' + cleaned;
  } else if (cleaned.length === 11) {
    return cleaned;
  }
  
  // Try to handle various NDC formats (5-4-2, 5-3-2, 4-4-2, etc.)
  const parts = ndc.toString().split('-');
  if (parts.length === 3) {
    const [labeler, product, pkg] = parts;
    const normalizedLabeler = labeler.padStart(5, '0');
    const normalizedProduct = product.padStart(4, '0');
    const normalizedPkg = pkg.padStart(2, '0');
    return normalizedLabeler + normalizedProduct + normalizedPkg;
  }
  
  return cleaned.padStart(11, '0').slice(0, 11);
}

/**
 * Parse date from various formats
 */
function parseDate(dateStr) {
  if (!dateStr) return null;

  const str = dateStr.toString().trim();

  // Handle SPP format: YYYYMMDD or YYYYMMDDHHMMSS (e.g., "20251226" or "20251226012332")
  if (/^\d{8,14}$/.test(str)) {
    const year = str.substring(0, 4);
    const month = str.substring(4, 6);
    const day = str.substring(6, 8);
    return `${year}-${month}-${day}`;
  }

  // Try common date formats
  const formats = [
    /^(\d{4})-(\d{2})-(\d{2})/, // YYYY-MM-DD
    /^(\d{2})\/(\d{2})\/(\d{4})/, // MM/DD/YYYY
    /^(\d{2})-(\d{2})-(\d{4})/, // MM-DD-YYYY
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/ // M/D/YY or M/D/YYYY
  ];

  for (const format of formats) {
    const match = str.match(format);
    if (match) {
      try {
        const date = new Date(str);
        if (!isNaN(date.getTime())) {
          return date.toISOString().split('T')[0];
        }
      } catch (e) {
        continue;
      }
    }
  }

  // Fallback: try direct parsing
  try {
    const date = new Date(str);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  } catch (e) {
    return null;
  }

  return null;
}

/**
 * Pad BIN to 6 digits (always 6 chars, left-padded with zeros)
 */
function padBIN(bin) {
  if (!bin) return null;
  const cleaned = bin.toString().replace(/\D/g, '');
  if (!cleaned) return null;
  return cleaned.padStart(6, '0').slice(0, 6);
}

/**
 * Pad PCN to 3 digits (always 3 chars, left-padded with zeros)
 */
function padPCN(pcn) {
  if (!pcn) return null;
  const cleaned = pcn.toString().trim();
  if (!cleaned) return null;
  // PCN can have letters, so just pad with zeros if it's numeric
  if (/^\d+$/.test(cleaned)) {
    return cleaned.padStart(3, '0');
  }
  return cleaned; // Keep as-is if alphanumeric
}

/**
 * Generate a deterministic patient hash from identifiable info
 * This anonymizes patient data while allowing for deduplication
 */
function generatePatientHash(firstName, lastName, dob) {
  const normalized = [
    (firstName || '').toLowerCase().trim(),
    (lastName || '').toLowerCase().trim(),
    dob || ''
  ].join('|');
  
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Validate a prescription record
 */
function validatePrescription(record) {
  const errors = [];
  
  if (!record.ndc) {
    errors.push('Missing NDC');
  } else if (record.ndc.length !== 11) {
    errors.push(`Invalid NDC format: ${record.ndc}`);
  }
  
  if (!record.drug_name) {
    errors.push('Missing drug name');
  }
  
  if (!record.quantity_dispensed || isNaN(parseFloat(record.quantity_dispensed))) {
    errors.push('Invalid quantity');
  }
  
  if (!record.dispensed_date) {
    errors.push('Missing dispensed date');
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Main CSV ingestion function
 */
export async function ingestCSV(buffer, options = {}) {
  const {
    pharmacyId,
    clientId,
    sourceEmail,
    sourceFile,
    pmsSystem
  } = options;

  const logId = uuidv4();
  const startTime = Date.now();
  
  logger.info('Starting CSV ingestion', { logId, pharmacyId, sourceFile });

  // Create ingestion log entry
  const ingestionLog = await db.insert('ingestion_logs', {
    log_id: logId,
    pharmacy_id: pharmacyId,
    client_id: clientId,
    source_type: 'csv_upload',
    source_file: sourceFile,
    source_email: sourceEmail,
    status: 'processing'
  });

  try {
    // Parse CSV
    const rawRecords = await parseCSV(buffer);
    
    if (rawRecords.length === 0) {
      throw new Error('CSV file is empty');
    }

    // Detect PMS system if not specified
    const headers = Object.keys(rawRecords[0]);
    const detectedPMS = pmsSystem || detectPMSSystem(headers);
    const mappings = PMS_COLUMN_MAPPINGS[detectedPMS] || PMS_COLUMN_MAPPINGS.generic;

    logger.info('CSV parsed', { logId, recordCount: rawRecords.length, pmsSystem: detectedPMS });

    // Transform records
    const prescriptions = [];
    const patients = new Map(); // patient_hash -> patient data
    const validationErrors = [];
    let duplicateCount = 0;

    for (let i = 0; i < rawRecords.length; i++) {
      const row = rawRecords[i];
      
      try {
        // Map columns to standardized fields
        let patientFirst = findColumnValue(row, mappings.patient_first);
        let patientLast = findColumnValue(row, mappings.patient_last);

        // Handle combined "Patient Full Name" field
        if (!patientFirst && !patientLast && mappings.patient_full_name) {
          const fullName = findColumnValue(row, mappings.patient_full_name);
          if (fullName) {
            const nameParts = fullName.trim().split(/\s+/);
            if (nameParts.length >= 2) {
              patientFirst = nameParts[0];
              patientLast = nameParts.slice(1).join(' ');
            } else {
              patientFirst = fullName;
              patientLast = '';
            }
          }
        }

        const patientDob = parseDate(findColumnValue(row, mappings.patient_dob));
        const patientHash = generatePatientHash(patientFirst, patientLast, patientDob);

        // Store patient data for later upsert
        if (!patients.has(patientHash)) {
          patients.set(patientHash, {
            patient_hash: patientHash,
            pharmacy_id: pharmacyId,
            first_name: patientFirst,
            last_name: patientLast,
            date_of_birth: patientDob,
            zip_code: findColumnValue(row, mappings.patient_zip),
            primary_insurance_bin: padBIN(findColumnValue(row, mappings.insurance_bin)),
            primary_insurance_pcn: padPCN(findColumnValue(row, mappings.insurance_pcn)),
            primary_insurance_group: findColumnValue(row, mappings.insurance_group)
          });
        }

        const prescription = {
          prescription_id: uuidv4(),
          pharmacy_id: pharmacyId,
          rx_number: findColumnValue(row, mappings.rx_number),
          ndc: normalizeNDC(findColumnValue(row, mappings.ndc)),
          drug_name: findColumnValue(row, mappings.drug_name),
          quantity_dispensed: parseFloat(findColumnValue(row, mappings.quantity_dispensed)) || 0,
          days_supply: parseInt(findColumnValue(row, mappings.days_supply)) || null,
          daw_code: findColumnValue(row, mappings.daw_code),
          prescriber_npi: findColumnValue(row, mappings.prescriber_npi),
          prescriber_name: findColumnValue(row, mappings.prescriber_name),
          insurance_bin: padBIN(findColumnValue(row, mappings.insurance_bin)),
          insurance_pcn: padPCN(findColumnValue(row, mappings.insurance_pcn)),
          insurance_group: findColumnValue(row, mappings.insurance_group),
          patient_pay: parseFloat(findColumnValue(row, mappings.patient_pay)) || null,
          insurance_pay: parseFloat(findColumnValue(row, mappings.insurance_pay)) || null,
          acquisition_cost: parseFloat(findColumnValue(row, mappings.acquisition_cost)) || null,
          gross_profit: parseFloat(findColumnValue(row, mappings.gross_profit)) || null,
          sig: findColumnValue(row, mappings.sig),
          dispensed_date: parseDate(findColumnValue(row, mappings.dispensed_date)),
          written_date: parseDate(findColumnValue(row, mappings.written_date)),
          refills_remaining: parseInt(findColumnValue(row, mappings.refills_remaining)) || null,
          source: 'csv_upload',
          source_file: sourceFile,
          raw_data: row,
          _patient_hash: patientHash // Temporary, for linking
        };

        // Validate
        const validation = validatePrescription(prescription);
        if (!validation.isValid) {
          validationErrors.push({
            row: i + 1,
            errors: validation.errors,
            data: row
          });
          continue;
        }

        prescriptions.push(prescription);
      } catch (error) {
        validationErrors.push({
          row: i + 1,
          errors: [error.message],
          data: row
        });
      }
    }

    logger.info('Records transformed', { 
      logId, 
      validPrescriptions: prescriptions.length,
      uniquePatients: patients.size,
      validationErrors: validationErrors.length 
    });

    // Upsert patients first
    const patientRecords = Array.from(patients.values());
    const patientMap = new Map(); // patient_hash -> patient_id
    
    for (const patient of patientRecords) {
      // Check if patient exists
      const existing = await db.query(
        'SELECT patient_id, first_name, last_name FROM patients WHERE patient_hash = $1 AND pharmacy_id = $2',
        [patient.patient_hash, pharmacyId]
      );

      if (existing.rows.length > 0) {
        const existingPatient = existing.rows[0];
        patientMap.set(patient.patient_hash, existingPatient.patient_id);

        // Update first_name/last_name if they're missing
        if ((!existingPatient.first_name || !existingPatient.last_name) && (patient.first_name || patient.last_name)) {
          await db.query(
            'UPDATE patients SET first_name = COALESCE(first_name, $1), last_name = COALESCE(last_name, $2) WHERE patient_id = $3',
            [patient.first_name, patient.last_name, existingPatient.patient_id]
          );
        }
      } else {
        const newPatient = await db.insert('patients', {
          patient_id: uuidv4(),
          ...patient
        });
        patientMap.set(patient.patient_hash, newPatient.patient_id);
      }
    }

    // Insert prescriptions with patient_id in batches
    let insertedCount = 0;
    const BATCH_SIZE = 50;

    // Prepare all prescriptions with patient_id
    for (const rx of prescriptions) {
      rx.patient_id = patientMap.get(rx._patient_hash);
      delete rx._patient_hash;
    }

    // Process in batches
    for (let i = 0; i < prescriptions.length; i += BATCH_SIZE) {
      const batch = prescriptions.slice(i, i + BATCH_SIZE);

      if (batch.length === 0) continue;

      // Build batch insert query
      const values = [];
      const valuePlaceholders = [];
      let paramIndex = 1;

      for (const rx of batch) {
        valuePlaceholders.push(`(${Array.from({length: 24}, () => `$${paramIndex++}`).join(', ')})`);
        values.push(
          rx.prescription_id, rx.pharmacy_id, rx.patient_id, rx.rx_number, rx.ndc, rx.drug_name,
          rx.quantity_dispensed, rx.days_supply, rx.daw_code, rx.prescriber_npi, rx.prescriber_name,
          rx.insurance_bin, rx.insurance_pcn, rx.insurance_group, rx.patient_pay, rx.insurance_pay,
          rx.acquisition_cost, rx.sig, rx.dispensed_date, rx.written_date, rx.refills_remaining,
          rx.source, rx.source_file, JSON.stringify(rx.raw_data)
        );
      }

      try {
        const result = await db.query(`
          INSERT INTO prescriptions (
            prescription_id, pharmacy_id, patient_id, rx_number, ndc, drug_name,
            quantity_dispensed, days_supply, daw_code, prescriber_npi, prescriber_name,
            insurance_bin, insurance_pcn, insurance_group, patient_pay, insurance_pay,
            acquisition_cost, sig, dispensed_date, written_date, refills_remaining,
            source, source_file, raw_data
          ) VALUES ${valuePlaceholders.join(', ')}
          ON CONFLICT (pharmacy_id, rx_number, dispensed_date) DO NOTHING
        `, values);
        insertedCount += result.rowCount || batch.length;
      } catch (error) {
        // If batch fails, fall back to individual inserts for this batch
        logger.warn('Batch insert failed, falling back to individual inserts', { error: error.message, batchStart: i });
        for (const rx of batch) {
          try {
            await db.query(`
              INSERT INTO prescriptions (
                prescription_id, pharmacy_id, patient_id, rx_number, ndc, drug_name,
                quantity_dispensed, days_supply, daw_code, prescriber_npi, prescriber_name,
                insurance_bin, insurance_pcn, insurance_group, patient_pay, insurance_pay,
                acquisition_cost, sig, dispensed_date, written_date, refills_remaining,
                source, source_file, raw_data
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
              ON CONFLICT (pharmacy_id, rx_number, dispensed_date) DO NOTHING
            `, [
              rx.prescription_id, rx.pharmacy_id, rx.patient_id, rx.rx_number, rx.ndc, rx.drug_name,
              rx.quantity_dispensed, rx.days_supply, rx.daw_code, rx.prescriber_npi, rx.prescriber_name,
              rx.insurance_bin, rx.insurance_pcn, rx.insurance_group, rx.patient_pay, rx.insurance_pay,
              rx.acquisition_cost, rx.sig, rx.dispensed_date, rx.written_date, rx.refills_remaining,
              rx.source, rx.source_file, JSON.stringify(rx.raw_data)
            ]);
            insertedCount++;
          } catch (err) {
            if (err.code === '23505') duplicateCount++;
          }
        }
      }
    }

    const processingTime = Date.now() - startTime;

    // Update ingestion log
    await db.update('ingestion_logs', 'log_id', logId, {
      total_records: rawRecords.length,
      successful_records: insertedCount,
      failed_records: validationErrors.length,
      duplicate_records: duplicateCount,
      validation_errors: validationErrors.length > 0 ? JSON.stringify(validationErrors.slice(0, 100)) : null,
      processing_time_ms: processingTime,
      status: validationErrors.length === rawRecords.length ? 'failed' : 
              validationErrors.length > 0 ? 'partial' : 'completed',
      completed_at: new Date()
    });

    logger.info('CSV ingestion completed', {
      logId,
      totalRecords: rawRecords.length,
      inserted: insertedCount,
      duplicates: duplicateCount,
      errors: validationErrors.length,
      processingTimeMs: processingTime
    });

    return {
      success: true,
      logId,
      stats: {
        totalRecords: rawRecords.length,
        inserted: insertedCount,
        duplicates: duplicateCount,
        errors: validationErrors.length,
        processingTimeMs: processingTime
      },
      validationErrors: validationErrors.slice(0, 20) // Return first 20 errors for review
    };

  } catch (error) {
    logger.error('CSV ingestion failed', { logId, error: error.message });
    
    await db.update('ingestion_logs', 'log_id', logId, {
      status: 'failed',
      error_message: error.message,
      completed_at: new Date()
    });

    throw error;
  }
}

/**
 * Get client and pharmacy from submitter email
 */
export async function resolveClientFromEmail(email) {
  const result = await db.query(`
    SELECT c.client_id, c.client_name, c.status as client_status,
           p.pharmacy_id, p.pharmacy_name, p.pharmacy_npi
    FROM clients c
    JOIN pharmacies p ON p.client_id = c.client_id
    WHERE c.submitter_email = $1
    AND c.status = 'active'
    AND p.is_active = true
    LIMIT 1
  `, [email.toLowerCase()]);
  
  return result.rows[0] || null;
}

export default {
  ingestCSV,
  resolveClientFromEmail,
  parseCSV,
  normalizeNDC,
  generatePatientHash
};
