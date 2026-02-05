// TheRxOS V2 - Fast Ingestion Service (Reusable Module)
// Extracted from ingest-fast.js for use in onboarding pipeline
// Supports progress tracking for real-time UI updates

import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 500;

// In-memory progress tracking
const progressMap = new Map();

// Column mapping for PioneerRx exports
const COLUMN_MAP = {
  'Rx Number': 'rx_number',
  'Patient Full Name Last then First': 'patient_name',
  'Patient Full Name': 'patient_name',
  'Patient Date of Birth': 'patient_dob',
  'Patient Age': 'patient_age',
  'Date Written': 'date_written',
  'Date Filled': 'date_written',
  'DAW Code': 'daw_code',
  'DAW': 'daw_code',
  'Dispensed Item Name': 'drug_name',
  'Dispensed Item NDC': 'ndc',
  'Dispensed Quantity': 'quantity',
  'Dispensing Unit': 'dispensing_unit',
  'Days Supply': 'days_supply',
  'Therapeutic Class Description': 'therapeutic_class',
  'PDC': 'pdc',
  'Dispensed AWP': 'awp',
  'Net Profit': 'net_profit',
  'Gross Profit': 'net_profit',
  'Acquisition Cost': 'acquisition_cost',
  'Patient Paid Amount': 'patient_pay',
  'Primary Contract ID': 'contract_id',
  'Primary Prescription Benefit Plan': 'plan_name',
  'Primary': 'primary_flag',
  'Primary Third Party Bin': 'insurance_bin',
  'Primary Group Number': 'group_number',
  'Primary Network Reimbursement': 'insurance_pay',
  'Primary Remit Amount': 'insurance_pay',
  'Prescriber Full Name': 'prescriber_name',
  'Prescriber Full Name First then Last': 'prescriber_name',
  'Prescriber Fax Number': 'prescriber_fax',
  'Prescriber NPI': 'prescriber_npi',
  'Primary Third Party PCN': 'pcn',
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

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i], delimiter);
    const row = {};
    headers.forEach((header, index) => {
      const mappedKey = COLUMN_MAP[header] || COLUMN_MAP_LOWER[header.toLowerCase()] || header.toLowerCase().replace(/\s+/g, '_');
      row[mappedKey] = values[index] || null;
    });
    rows.push(row);
  }
  return { rows, delimiter, columnCount: headers.length };
}

// Clean patient name: remove (BP), (RX), etc. and normalize spacing/case
function cleanPatientName(name) {
  return (name || '')
    .replace(/\([^)]*\)/g, '')  // Remove parenthetical like (BP)
    .replace(/\*+/g, '')        // Remove asterisks
    .replace(/\s+/g, ' ')       // Normalize whitespace
    .trim();
}

function generatePatientHash(name, dob) {
  const cleanName = cleanPatientName(name);
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

function normalizeDawCode(daw) {
  if (!daw) return '0';
  const d = String(daw).trim();
  // Already a code (0-9)
  if (/^\d$/.test(d)) return d;
  // Map text descriptions to codes
  const lower = d.toLowerCase();
  if (lower.includes('no product selection')) return '0';
  if (lower.includes('not allowed by prescriber') || lower.includes('substitution not allowed')) return '1';
  if (lower.includes('patient requested')) return '2';
  if (lower.includes('pharmacist selected')) return '3';
  if (lower.includes('not in stock')) return '4';
  if (lower.includes('brand drug dispensed as generic')) return '5';
  if (lower.includes('override')) return '6';
  if (lower.includes('mandated by law')) return '7';
  if (lower.includes('not available in marketplace')) return '8';
  if (lower.includes('other')) return '9';
  // Fallback: take first char if numeric, else 0
  return /^\d/.test(d) ? d[0] : '0';
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

/**
 * Start a fast ingestion job with progress tracking
 * @param {string} pharmacyId - Target pharmacy UUID
 * @param {string|Buffer} csvContent - CSV file content (string or Buffer)
 * @returns {string} jobId for polling progress
 */
export function startIngestion(pharmacyId, csvContent) {
  const jobId = uuidv4();
  const content = typeof csvContent === 'string' ? csvContent : csvContent.toString('utf-8');

  progressMap.set(jobId, {
    status: 'parsing',
    phase: 'Parsing CSV',
    current: 0,
    total: 0,
    result: null,
    error: null,
    startedAt: Date.now(),
  });

  // Run ingestion async
  runIngestion(jobId, pharmacyId, content).catch(err => {
    const progress = progressMap.get(jobId);
    if (progress) {
      progress.status = 'error';
      progress.error = err.message;
    }
    logger.error('Fast ingestion error', { jobId, error: err.message });
  });

  return jobId;
}

/**
 * Get progress for an ingestion job
 * @param {string} jobId
 * @returns {object|null} progress info
 */
export function getProgress(jobId) {
  return progressMap.get(jobId) || null;
}

/**
 * Run the full ingestion (called async by startIngestion)
 */
async function runIngestion(jobId, pharmacyId, csvContent) {
  const progress = progressMap.get(jobId);

  // Parse CSV
  const { rows } = parseCSV(csvContent);
  progress.total = rows.length;
  progress.phase = 'Processing patients';
  progress.status = 'patients';

  // PHASE 1: Collect unique patients
  const patientMap = new Map();

  for (const row of rows) {
    if (!row.patient_name) continue;
    const hash = generatePatientHash(row.patient_name, row.patient_dob || '');
    const rxDate = parseDate(row.date_written) || '1900-01-01';

    if (!patientMap.has(hash)) {
      // Clean and parse name - remove (BP), asterisks, etc.
      const cleanedName = cleanPatientName(row.patient_name);
      const nameParts = cleanedName.split(',').map(s => s.trim());
      const lastName = nameParts[0] || '';
      const firstName = nameParts[1] || '';

      patientMap.set(hash, {
        patient_id: uuidv4(),
        hash,
        first_name: firstName,
        last_name: lastName,
        dob: parseDate(row.patient_dob),
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
    if (row.drug_name && !patient.prescriptions.includes(row.drug_name)) {
      patient.prescriptions.push(row.drug_name);
    }

    const conditions = inferConditions(row.therapeutic_class);
    conditions.forEach(c => patient.conditions.add(c));
  }

  // Batch insert patients
  const patientBatches = [];
  let patientBatch = [];
  for (const [, patient] of patientMap) {
    patientBatch.push(patient);
    if (patientBatch.length >= BATCH_SIZE) {
      patientBatches.push(patientBatch);
      patientBatch = [];
    }
  }
  if (patientBatch.length > 0) patientBatches.push(patientBatch);

  let patientsInserted = 0;
  progress.total = patientMap.size;

  for (const batch of patientBatches) {
    const values = batch.map((p, i) => {
      const offset = i * 10;
      return `($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8}, $${offset+9}, $${offset+10})`;
    }).join(', ');

    const params = batch.flatMap(p => [
      p.patient_id,
      pharmacyId,
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
      await db.query(`
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
      progress.current = patientsInserted;
    } catch (err) {
      logger.error('Patient batch error', { jobId, error: err.message });
    }
  }

  // Fetch actual patient IDs from database
  const patientLookup = new Map();
  const patientResult = await db.query(
    'SELECT patient_id, patient_hash FROM patients WHERE pharmacy_id = $1',
    [pharmacyId]
  );
  for (const row of patientResult.rows) {
    patientLookup.set(row.patient_hash, row.patient_id);
  }

  // PHASE 2: Batch insert prescriptions
  progress.phase = 'Processing prescriptions';
  progress.status = 'prescriptions';
  progress.current = 0;

  const allRx = [];
  for (const row of rows) {
    if (!row.patient_name || !row.ndc || !row.drug_name) continue;

    const patientHash = generatePatientHash(row.patient_name, row.patient_dob || '');
    const patientId = patientLookup.get(patientHash);
    if (!patientId) continue;

    let contractId = null;
    let planName = null;
    if (row.contract_id) contractId = String(row.contract_id).trim();
    if (row.plan_name) planName = String(row.plan_name).trim().padStart(3, '0');

    allRx.push({
      prescription_id: uuidv4(),
      pharmacy_id: pharmacyId,
      patient_id: patientId,
      rx_number: row.rx_number,
      ndc: (row.ndc || '').replace(/-/g, ''),
      drug_name: row.drug_name,
      quantity: parseFloat(row.quantity) || 0,
      days_supply: parseInt(row.days_supply) || 30,
      dispensed_date: parseDate(row.date_written) || new Date().toISOString().split('T')[0],
      insurance_bin: row.insurance_bin,
      insurance_group: row.group_number,
      insurance_pcn: row.pcn || null,
      contract_id: contractId,
      plan_name: planName,
      patient_pay: parseAmount(row.patient_pay),
      insurance_pay: parseAmount(row.insurance_pay),
      prescriber_name: row.prescriber_name,
      prescriber_npi: row.prescriber_npi || null,
      daw_code: normalizeDawCode(row.daw_code),
      raw_data: JSON.stringify({
        therapeutic_class: row.therapeutic_class,
        pdc: row.pdc,
        awp: parseAmount(row.awp),
        net_profit: parseAmount(row.net_profit),
        prescriber_fax: row.prescriber_fax || null,
      })
    });
  }

  // De-duplicate within file
  const seenRx = new Set();
  const dedupedRx = [];
  for (const rx of allRx) {
    const rxKey = `${rx.rx_number}|${rx.dispensed_date}`;
    if (seenRx.has(rxKey)) continue;
    seenRx.add(rxKey);
    dedupedRx.push(rx);
  }

  progress.total = dedupedRx.length;

  // Batch insert
  const rxBatches = [];
  let rxBatch = [];
  for (const rx of dedupedRx) {
    rxBatch.push(rx);
    if (rxBatch.length >= BATCH_SIZE) {
      rxBatches.push(rxBatch);
      rxBatch = [];
    }
  }
  if (rxBatch.length > 0) rxBatches.push(rxBatch);

  let rxInserted = 0;
  let rxSkipped = 0;

  for (const batch of rxBatches) {
    const values = batch.map((rx, i) => {
      const o = i * 20;
      return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},$${o+9},$${o+10},$${o+11},$${o+12},$${o+13},$${o+14},$${o+15},$${o+16},$${o+17},$${o+18},$${o+19},$${o+20})`;
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
      rx.insurance_pcn,
      rx.contract_id,
      rx.plan_name,
      rx.patient_pay,
      rx.insurance_pay,
      rx.prescriber_name,
      rx.prescriber_npi,
      rx.daw_code,
      rx.raw_data
    ]);

    try {
      await db.query(`
        INSERT INTO prescriptions (
          prescription_id, pharmacy_id, patient_id, rx_number, ndc, drug_name,
          quantity_dispensed, days_supply, dispensed_date, insurance_bin, insurance_group,
          insurance_pcn, contract_id, plan_name, patient_pay, insurance_pay, prescriber_name,
          prescriber_npi, daw_code, raw_data
        ) VALUES ${values}
        ON CONFLICT (pharmacy_id, rx_number, dispensed_date) DO UPDATE SET
          drug_name = EXCLUDED.drug_name,
          contract_id = EXCLUDED.contract_id,
          plan_name = EXCLUDED.plan_name,
          prescriber_npi = COALESCE(EXCLUDED.prescriber_npi, prescriptions.prescriber_npi),
          insurance_pcn = COALESCE(EXCLUDED.insurance_pcn, prescriptions.insurance_pcn),
          raw_data = EXCLUDED.raw_data
      `, params);
      rxInserted += batch.length;
    } catch (err) {
      rxSkipped += batch.length;
      logger.error('Prescription batch error', { jobId, error: err.message });
    }

    progress.current = rxInserted + rxSkipped;
  }

  // Done
  const result = {
    records: rows.length,
    patients: patientsInserted,
    prescriptions: rxInserted,
    duplicatesRemoved: allRx.length - dedupedRx.length,
    skipped: rxSkipped,
  };

  progress.status = 'complete';
  progress.phase = 'Complete';
  progress.result = result;

  logger.info('Fast ingestion complete', { jobId, pharmacyId, ...result });

  // Clean up progress after 30 minutes
  setTimeout(() => progressMap.delete(jobId), 30 * 60 * 1000);

  return result;
}

/**
 * Run ingestion synchronously (blocking) and return result directly
 * Used when caller doesn't need progress tracking
 */
export async function ingestSync(pharmacyId, csvContent) {
  const jobId = uuidv4();
  const content = typeof csvContent === 'string' ? csvContent : csvContent.toString('utf-8');

  progressMap.set(jobId, {
    status: 'parsing',
    phase: 'Parsing CSV',
    current: 0,
    total: 0,
    result: null,
    error: null,
    startedAt: Date.now(),
  });

  const result = await runIngestion(jobId, pharmacyId, content);
  return result;
}

export default {
  startIngestion,
  getProgress,
  ingestSync,
};
