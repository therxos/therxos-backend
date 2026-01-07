// Sync V1 opportunities from CSV to V2 database
// Usage: node scripts/sync-v1-opportunities.js <csv_path>

import 'dotenv/config';
import { parse } from 'csv-parse';
import { readFileSync } from 'fs';
import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// V1 status mapping to V2 statuses
// Valid V2 statuses: 'Not Submitted', 'Submitted', 'Approved', 'Completed', 'Denied', "Didn't Work"
const STATUS_MAPPING = {
  '': 'Not Submitted',
  'Not Submitted': 'Not Submitted',
  "Didn't work": "Didn't Work",
  'Didnt work': "Didn't Work",
  'Submitted': 'Submitted',
  'Pending': 'Submitted',
  'Approved': 'Approved',
  'Completed': 'Completed',
  'Rejected': 'Denied',
  'Declined': 'Denied',
  'Denied': 'Denied',
};

// Statuses that should NOT be overwritten (already actioned in V2)
const PROTECTED_STATUSES = ['Completed', 'Approved'];

async function syncOpportunities(csvPath) {
  console.log('Reading CSV:', csvPath);
  const csvContent = readFileSync(csvPath, 'utf-8');

  // Parse CSV
  const records = await new Promise((resolve, reject) => {
    parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      relax_quotes: true,
      relax_column_count: true,
    }, (err, records) => {
      if (err) reject(err);
      else resolve(records);
    });
  });

  console.log(`Parsed ${records.length} V1 opportunities`);

  // Get Bravo pharmacy ID
  const bravoResult = await pool.query(
    "SELECT pharmacy_id FROM pharmacies WHERE pharmacy_name ILIKE '%bravo%'"
  );
  if (bravoResult.rows.length === 0) {
    console.error('Bravo pharmacy not found');
    process.exit(1);
  }
  const pharmacyId = bravoResult.rows[0].pharmacy_id;
  console.log('Bravo pharmacy ID:', pharmacyId);

  // Get all V2 opportunities for Bravo with patient info
  const v2Opps = await pool.query(`
    SELECT o.opportunity_id, o.status, o.staff_notes, o.outcome_notes,
           p.first_name, p.last_name, p.date_of_birth,
           o.current_drug_name, o.recommended_drug_name, o.opportunity_type
    FROM opportunities o
    LEFT JOIN patients p ON p.patient_id = o.patient_id
    WHERE o.pharmacy_id = $1
  `, [pharmacyId]);

  console.log(`Found ${v2Opps.rows.length} V2 opportunities`);

  // Build multiple lookups for flexible matching
  const v2Lookup = new Map();      // Full key: "LAS,FIR|DRUG"
  const v2ByPatient = new Map();   // Just patient: "LAS,FIR"
  const v2ByLastName = new Map();  // Just last name for fallback
  const v2ByDob = new Map();       // By DOB for edge cases

  for (const opp of v2Opps.rows) {
    // Create key: first 3 chars of last + first 3 chars of first + recommended drug
    const lastName = cleanPatientName(opp.last_name || '').substring(0, 3);
    const firstName = cleanPatientName(opp.first_name || '').substring(0, 3);
    const drug = normalizeDrug(opp.recommended_drug_name || '');
    const patientKey = `${lastName},${firstName}`;
    const fullKey = `${patientKey}|${drug}`;

    // Full key lookup
    if (!v2Lookup.has(fullKey)) {
      v2Lookup.set(fullKey, []);
    }
    v2Lookup.get(fullKey).push(opp);

    // Patient-only lookup (for fuzzy drug matching)
    if (!v2ByPatient.has(patientKey)) {
      v2ByPatient.set(patientKey, []);
    }
    v2ByPatient.get(patientKey).push(opp);

    // Last name only lookup
    if (!v2ByLastName.has(lastName)) {
      v2ByLastName.set(lastName, []);
    }
    v2ByLastName.get(lastName).push(opp);

    // DOB lookup for edge cases
    if (opp.date_of_birth) {
      const dob = formatDob(opp.date_of_birth);
      if (!v2ByDob.has(dob)) {
        v2ByDob.set(dob, []);
      }
      v2ByDob.get(dob).push(opp);
    }
  }

  console.log('Built lookup with', v2Lookup.size, 'unique keys');

  let matched = 0;
  let updated = 0;
  let skippedProtected = 0;
  let notFound = 0;
  const unmatchedRecords = [];

  for (const v1 of records) {
    // Parse V1 opportunity ID: "LASTNAME,FIRSTNAME|DRUGKEY|MMDDYY"
    const oppId = v1.Opportunity_ID || v1['Opportunity_ID'] || '';
    const parts = oppId.split('|');
    if (parts.length < 2) {
      console.log('Invalid opportunity ID:', oppId);
      continue;
    }

    const patientPart = parts[0]; // "THO,(BP" or "CAS,NEL"
    const drugPart = parts[1]; // "LAMOTRIGINEODT"

    // Clean patient name - remove annotations like (BP
    const patientParts = patientPart.split(',');
    const cleanLast = cleanPatientName(patientParts[0] || '').substring(0, 3);
    const cleanFirst = cleanPatientName(patientParts[1] || '').substring(0, 3);
    const cleanPatientKey = `${cleanLast},${cleanFirst}`;

    // Build lookup keys
    const normalizedDrug = normalizeDrug(v1.Recommended_Drug || '');
    const drugFromId = normalizeDrug(drugPart);

    // Try multiple matching strategies
    let v2Matches = [];

    // Strategy 1: Exact match with cleaned patient + drug from CSV
    const key1 = `${cleanPatientKey}|${normalizedDrug}`;
    v2Matches = v2Lookup.get(key1) || [];

    // Strategy 2: Cleaned patient + drug from opportunity ID
    if (v2Matches.length === 0) {
      const key2 = `${cleanPatientKey}|${drugFromId}`;
      v2Matches = v2Lookup.get(key2) || [];
    }

    // Strategy 3: Patient match with fuzzy drug comparison
    if (v2Matches.length === 0) {
      const patientOpps = v2ByPatient.get(cleanPatientKey) || [];
      for (const opp of patientOpps) {
        if (drugsSimilar(v1.Recommended_Drug, opp.recommended_drug_name) ||
            drugsSimilar(drugPart, opp.recommended_drug_name)) {
          v2Matches.push(opp);
        }
      }
    }

    // Strategy 4: Try with shorter name prefixes for edge cases
    if (v2Matches.length === 0 && cleanLast.length >= 2) {
      const shortKey = `${cleanLast.substring(0, 2)},${cleanFirst.substring(0, 2)}`;
      for (const [lookupKey, opps] of v2ByPatient.entries()) {
        if (lookupKey.startsWith(shortKey)) {
          for (const opp of opps) {
            if (drugsSimilar(v1.Recommended_Drug, opp.recommended_drug_name) ||
                drugsSimilar(drugPart, opp.recommended_drug_name)) {
              v2Matches.push(opp);
            }
          }
          if (v2Matches.length > 0) break;
        }
      }
    }

    // Strategy 5: Last name + DOB + drug matching (for "(BP" type names)
    if (v2Matches.length === 0) {
      const v1Dob = formatDob(v1.Patient_DOB || v1['Patient_DOB'] || '');
      if (v1Dob) {
        const dobOpps = v2ByDob.get(v1Dob) || [];
        for (const opp of dobOpps) {
          const oppLastName = cleanPatientName(opp.last_name || '').substring(0, 3);
          if (oppLastName === cleanLast) {
            if (drugsSimilar(v1.Recommended_Drug, opp.recommended_drug_name) ||
                drugsSimilar(drugPart, opp.recommended_drug_name)) {
              v2Matches.push(opp);
            }
          }
        }
      }
    }

    // Strategy 6: Just last name + drug (last resort)
    if (v2Matches.length === 0) {
      const lastNameOpps = v2ByLastName.get(cleanLast) || [];
      for (const opp of lastNameOpps) {
        if (drugsSimilar(v1.Recommended_Drug, opp.recommended_drug_name) ||
            drugsSimilar(drugPart, opp.recommended_drug_name)) {
          v2Matches.push(opp);
        }
      }
    }

    if (v2Matches.length === 0) {
      notFound++;
      unmatchedRecords.push({
        opportunity_id: oppId,
        patient: v1.Patient_Masked,
        dob: v1.Patient_DOB,
        current_drug: v1.Current_Drug,
        recommended_drug: v1.Recommended_Drug,
        status: v1.Status,
        annual_value: v1['Annual Value'],
        notes: v1.Notes
      });
      if (notFound <= 20) {
        console.log('No V2 match for:', oppId, '| Clean:', cleanPatientKey, '| Drug:', v1.Recommended_Drug, '| DOB:', v1.Patient_DOB);
      }
      continue;
    }

    matched++;

    // Get V1 status and notes
    const v1Status = v1.Status || v1['Status'] || '';
    const v1Notes = v1.Notes || v1['Notes'] || '';
    const v1RphConsult = v1.RPh_Consult || v1['RPh_Consult'] || '';
    const v1_2ndAttempt = v1['2nd Attempt'] || v1['2nd_Attempt'] || '';
    const v1FinalAttempt = v1.Final_Attempt || v1['Final_Attempt'] || '';

    // Combine V1 notes
    const combinedNotes = [v1RphConsult, v1_2ndAttempt, v1FinalAttempt, v1Notes]
      .filter(n => n && n.trim())
      .join(' | ');

    // Map V1 status to V2
    const mappedStatus = STATUS_MAPPING[v1Status.trim()] || 'Not Submitted';

    // Update each matching V2 opportunity
    for (const v2 of v2Matches) {
      // Skip if V2 status is protected (already actioned)
      if (PROTECTED_STATUSES.includes(v2.status)) {
        skippedProtected++;
        continue;
      }

      // Only update if status is different or we have notes to add
      if (v2.status !== mappedStatus || (combinedNotes && !v2.staff_notes)) {
        await pool.query(`
          UPDATE opportunities
          SET status = $1,
              staff_notes = $2,
              updated_at = NOW()
          WHERE opportunity_id = $3
        `, [mappedStatus, combinedNotes || v2.staff_notes, v2.opportunity_id]);
        updated++;
      }
    }
  }

  console.log('\n--- Sync Results ---');
  console.log('V1 records:', records.length);
  console.log('Matched:', matched);
  console.log('Updated:', updated);
  console.log('Skipped (protected):', skippedProtected);
  console.log('Not found:', notFound);

  // Show final status counts
  const finalCounts = await pool.query(`
    SELECT status, COUNT(*) as count
    FROM opportunities
    WHERE pharmacy_id = $1
    GROUP BY status
    ORDER BY count DESC
  `, [pharmacyId]);
  console.log('\nFinal status distribution:');
  for (const row of finalCounts.rows) {
    console.log(`  ${row.status}: ${row.count}`);
  }

  // Export unmatched records to CSV
  if (unmatchedRecords.length > 0) {
    const { writeFileSync } = await import('fs');
    const outputPath = csvPath.replace('.csv', '_unmatched.csv');

    const headers = ['opportunity_id', 'patient', 'dob', 'current_drug', 'recommended_drug', 'status', 'annual_value', 'notes'];
    const csvLines = [headers.join(',')];

    for (const rec of unmatchedRecords) {
      const row = headers.map(h => {
        const val = rec[h] || '';
        // Escape quotes and wrap in quotes if contains comma
        if (val.includes(',') || val.includes('"')) {
          return '"' + val.replace(/"/g, '""') + '"';
        }
        return val;
      });
      csvLines.push(row.join(','));
    }

    writeFileSync(outputPath, csvLines.join('\n'));
    console.log(`\nUnmatched records exported to: ${outputPath}`);
  }

  await pool.end();
}

function normalizeDrug(drug) {
  if (!drug) return '';
  // Remove parenthetical content, normalize to uppercase, remove spaces/special chars
  return drug
    .toUpperCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim();
}

function cleanPatientName(name) {
  if (!name) return '';
  // Remove annotations like (BP, (B, etc. and normalize
  return name
    .toUpperCase()
    .replace(/\([^)]*\)?/g, '')  // Remove parenthetical annotations
    .replace(/[^A-Z]/g, '')      // Keep only letters
    .trim();
}

function drugsSimilar(drug1, drug2) {
  if (!drug1 || !drug2) return false;
  const d1 = normalizeDrug(drug1);
  const d2 = normalizeDrug(drug2);
  // Check if one contains the other or they share significant overlap
  if (d1.includes(d2) || d2.includes(d1)) return true;
  // Check first 10 chars match (for drugs like LEVALBUTEROLHFA)
  if (d1.substring(0, 10) === d2.substring(0, 10) && d1.length >= 10) return true;
  return false;
}

function formatDob(dob) {
  // Convert various DOB formats to MMDDYY
  if (!dob) return '';
  try {
    let d;
    if (dob instanceof Date) {
      d = dob;
    } else if (typeof dob === 'string') {
      // Handle M/D/YYYY or MM/DD/YYYY format
      if (dob.includes('/')) {
        const parts = dob.split('/');
        const month = parts[0].padStart(2, '0');
        const day = parts[1].padStart(2, '0');
        const year = parts[2].length === 4 ? parts[2].substring(2) : parts[2];
        return month + day + year;
      }
      d = new Date(dob);
    }
    if (d && !isNaN(d.getTime())) {
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const year = String(d.getFullYear()).substring(2);
      return month + day + year;
    }
  } catch (e) {}
  return '';
}

// Run with CSV path argument
const csvPath = process.argv[2];
if (!csvPath) {
  console.error('Usage: node scripts/sync-v1-opportunities.js <csv_path>');
  process.exit(1);
}

syncOpportunities(csvPath).catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
