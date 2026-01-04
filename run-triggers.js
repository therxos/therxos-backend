// TheRxOS V2 - Trigger-Based Opportunity Scanner
// Reads triggers from CSV and applies them to patient prescriptions
// Run with: node run-triggers.js <client-email> [trigger-csv-path]

import 'dotenv/config';
import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ============================================
// CSV PARSING
// ============================================
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function loadTriggers(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = parseCSVLine(lines[0]);
  
  const triggers = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const trigger = {};
    headers.forEach((header, idx) => {
      trigger[header.trim()] = values[idx] || '';
    });
    
    // Only load enabled triggers
    if (trigger['Enabled']?.toUpperCase() === 'TRUE') {
      triggers.push(trigger);
    }
  }
  
  return triggers;
}

// Map trigger categories to valid opportunity_type values
function mapCategoryToType(category) {
  const cat = (category || '').toUpperCase();
  
  // Direct mappings
  if (cat.includes('NDC')) return 'ndc_optimization';
  if (cat.includes('BRAND') && cat.includes('GENERIC')) return 'brand_to_generic';
  if (cat.includes('MISSING') || cat.includes('ADD-ON') || cat.includes('ADDON')) return 'missing_therapy';
  if (cat.includes('AUDIT')) return 'audit_flag';
  if (cat.includes('MED SYNC') || cat.includes('MEDSYNC')) return 'med_sync';
  
  // Category mappings
  const mappings = {
    'THERAPEUTIC ALT': 'therapeutic_interchange',
    'FORMULATION CHANGE': 'therapeutic_interchange',
    'PILL COUNT': 'therapeutic_interchange',
    'GLP-1 SUPPORT': 'missing_therapy',
    'MISSING DIABETIC SUPPLY': 'missing_therapy',
    'MISSING DIAGNOSTIC DEVICE': 'missing_therapy',
    'MISSING SPACER': 'missing_therapy',
    'SMOKING CESSATION': 'missing_therapy',
    'ADD-ON THERAPY': 'missing_therapy',
  };
  
  for (const [key, value] of Object.entries(mappings)) {
    if (cat.includes(key)) return value;
  }
  
  // Default
  return 'therapeutic_interchange';
}

// ============================================
// HELPER FUNCTIONS
// ============================================

// Parse keywords from comma-separated string
function parseKeywords(str) {
  if (!str) return [];
  return str.split(',').map(k => k.trim().toUpperCase()).filter(k => k);
}

// Check if drug name matches any keyword
function matchesKeywords(drugName, keywords) {
  if (!keywords.length) return false;
  const upper = (drugName || '').toUpperCase();
  return keywords.some(kw => upper.includes(kw));
}

// Parse BIN restriction like "ONLY 610097" or "ONLY 610097, 610011"
function parseBinRestriction(restriction) {
  if (!restriction) return { type: 'ALL', bins: [] };
  const upper = restriction.toUpperCase().trim();
  
  if (upper === 'ALL') return { type: 'ALL', bins: [] };
  
  if (upper.startsWith('ONLY ')) {
    const bins = upper.replace('ONLY ', '').split(',').map(b => b.trim()).filter(b => b);
    return { type: 'ONLY', bins };
  }
  
  return { type: 'ALL', bins: [] };
}

// Parse Group restriction like "ONLY COS", "ALL EXCEPT PDPIND", "ALL"
// Also handles BIN-specific: "610097:ALL EXCEPT COS, PDPIND, 610011:ONLY RXMEDD"
function parseGroupRestriction(restriction, bin) {
  if (!restriction) return { type: 'ALL', groups: [] };
  const upper = restriction.toUpperCase().trim();
  
  if (upper === 'ALL') return { type: 'ALL', groups: [] };
  
  // Handle BIN-specific restrictions like "610097:ALL EXCEPT COS, PDPIND, 610011:ONLY RXMEDD"
  // We need to split by BIN boundaries, not by commas
  if (upper.includes(':')) {
    // Find all BIN:RULE patterns using regex
    // Match patterns like "610097:ALL EXCEPT COS, PDPIND" or "610011:ONLY RXMEDD"
    const binPatterns = upper.match(/(\d{6})\s*:\s*([^:]+?)(?=\s*,?\s*\d{6}\s*:|$)/g);
    
    if (binPatterns) {
      for (const pattern of binPatterns) {
        const colonIdx = pattern.indexOf(':');
        const binPart = pattern.substring(0, colonIdx).trim();
        const groupPart = pattern.substring(colonIdx + 1).trim().replace(/,\s*$/, ''); // Remove trailing comma
        
        if (binPart === bin) {
          // Recursively parse the group rule part (without BIN prefix)
          return parseGroupRestriction(groupPart, null);
        }
      }
    }
    // If no matching BIN found, default to ALL (trigger applies to all groups for this BIN)
    return { type: 'ALL', groups: [] };
  }
  
  if (upper.startsWith('ONLY ')) {
    const groups = upper.replace('ONLY ', '').split(',').map(g => g.trim()).filter(g => g);
    return { type: 'ONLY', groups };
  }
  
  if (upper.startsWith('ALL EXCEPT ')) {
    const groups = upper.replace('ALL EXCEPT ', '').split(',').map(g => g.trim()).filter(g => g);
    return { type: 'EXCEPT', groups };
  }
  
  // Handle just "EXCEPT X, Y" without ALL prefix
  if (upper.startsWith('EXCEPT ')) {
    const groups = upper.replace('EXCEPT ', '').split(',').map(g => g.trim()).filter(g => g);
    return { type: 'EXCEPT', groups };
  }
  
  // If it's just a list of groups without ONLY/EXCEPT, treat as ONLY
  if (upper.match(/^[A-Z0-9,\s]+$/)) {
    const groups = upper.split(',').map(g => g.trim()).filter(g => g);
    if (groups.length > 0) {
      return { type: 'ONLY', groups };
    }
  }
  
  return { type: 'ALL', groups: [] };
}

// Check if patient's BIN matches restriction
function binMatches(patientBin, restriction) {
  const { type, bins } = parseBinRestriction(restriction);
  if (type === 'ALL') return true;
  if (type === 'ONLY') return bins.includes(patientBin);
  return true;
}

// Check if patient's Group matches restriction
function groupMatches(patientGroup, restriction, patientBin) {
  const { type, groups } = parseGroupRestriction(restriction, patientBin);
  const upperGroup = (patientGroup || '').toUpperCase();
  
  if (type === 'ALL') return true;
  if (type === 'ONLY') return groups.some(g => upperGroup.includes(g));
  if (type === 'EXCEPT') return !groups.some(g => upperGroup.includes(g));
  return true;
}

// Get GP value for a BIN from trigger
function getGPForBin(trigger, bin) {
  const columnName = `New GP - ${bin}`;
  const value = trigger[columnName];
  
  if (!value || value.toUpperCase() === 'EXCLUDE') return null;
  
  // Parse currency value
  const cleaned = value.replace(/[$,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ============================================
// TRIGGER PROCESSING
// ============================================

async function processStandardTrigger(trigger, pharmacy_id, patientRxMap) {
  const opportunities = [];
  
  const detectionKeywords = parseKeywords(trigger['Detection Keywords']);
  const excludeKeywords = parseKeywords(trigger['Exclude Keywords']);
  
  if (detectionKeywords.length === 0) return opportunities;
  
  for (const [patientId, patientData] of patientRxMap) {
    const { prescriptions, bin, group } = patientData;
    
    // Check BIN restriction
    if (!binMatches(bin, trigger['BIN Restriction'])) continue;
    
    // Check Group restriction
    if (!groupMatches(group, trigger['Group Restriction'], bin)) continue;
    
    // Get GP for this BIN
    const gp = getGPForBin(trigger, bin);
    if (gp === null) continue; // EXCLUDE for this BIN
    
    // Find matching prescriptions
    for (const rx of prescriptions) {
      const drugName = rx.drug_name || '';
      
      // Check if matches detection keywords
      if (!matchesKeywords(drugName, detectionKeywords)) continue;
      
      // Check if should be excluded
      if (excludeKeywords.length > 0 && matchesKeywords(drugName, excludeKeywords)) continue;
      
      // Create opportunity
      opportunities.push({
        pharmacy_id,
        patient_id: patientId,
        prescription_id: rx.prescription_id,
        trigger_id: trigger['Trigger ID'],
        opportunity_type: mapCategoryToType(trigger['Category']),
        category: trigger['Category'] || 'Therapeutic Alt', // Keep original for display
        current_ndc: rx.ndc,
        current_drug_name: drugName,
        recommended_drug_name: trigger['Recommended Med'],
        potential_margin_gain: gp,
        annual_fills: parseInt(trigger['Annual Fills']) || 12,
        clinical_rationale: trigger['Display Name'],
        action: trigger['Action'],
        clinical_priority: (trigger['Priority'] || 'MEDIUM').toUpperCase(),
        bin,
        group,
        prescriber_name: rx.prescriber_name,
      });
    }
  }
  
  return opportunities;
}

async function processConditionalTrigger(trigger, pharmacy_id, patientRxMap) {
  const opportunities = [];
  
  const ifHasKeywords = parseKeywords(trigger['IF_HAS']);
  const ifNotHasKeywords = parseKeywords(trigger['IF_NOT_HAS']);
  
  if (ifHasKeywords.length === 0) return opportunities;
  
  for (const [patientId, patientData] of patientRxMap) {
    const { prescriptions, bin, group } = patientData;
    
    // Check BIN restriction
    if (!binMatches(bin, trigger['BIN Restriction'])) continue;
    
    // Check Group restriction
    if (!groupMatches(group, trigger['Group Restriction'], bin)) continue;
    
    // Get GP for this BIN
    const gp = getGPForBin(trigger, bin);
    if (gp === null) continue;
    
    // Check IF_HAS - patient must have at least one of these drugs
    const allDrugNames = prescriptions.map(rx => (rx.drug_name || '').toUpperCase()).join(' ');
    const hasRequired = ifHasKeywords.some(kw => allDrugNames.includes(kw));
    if (!hasRequired) continue;
    
    // Check IF_NOT_HAS - patient must NOT have these
    const hasExcluded = ifNotHasKeywords.some(kw => allDrugNames.includes(kw));
    if (hasExcluded) continue;
    
    // Find the triggering prescription (the IF_HAS drug)
    const triggeringRx = prescriptions.find(rx => 
      ifHasKeywords.some(kw => (rx.drug_name || '').toUpperCase().includes(kw))
    );
    
    if (!triggeringRx) continue;
    
    // Create opportunity
    opportunities.push({
      pharmacy_id,
      patient_id: patientId,
      prescription_id: triggeringRx.prescription_id,
      trigger_id: trigger['Trigger ID'],
      opportunity_type: mapCategoryToType(trigger['Category']),
      category: trigger['Category'] || 'Missing Therapy',
      current_ndc: triggeringRx.ndc,
      current_drug_name: triggeringRx.drug_name,
      recommended_drug_name: trigger['Recommended Med'],
      potential_margin_gain: gp,
      annual_fills: parseInt(trigger['Annual Fills']) || 1,
      clinical_rationale: trigger['Display Name'],
      action: trigger['Action'],
      clinical_priority: (trigger['Priority'] || 'MEDIUM').toUpperCase(),
      bin,
      group,
      prescriber_name: triggeringRx.prescriber_name,
    });
  }
  
  return opportunities;
}

async function processComboTrigger(trigger, pharmacy_id, patientRxMap) {
  const opportunities = [];
  
  const comboReq = trigger['Combo Requirements'] || '';
  const excludeKeywords = parseKeywords(trigger['Exclude Keywords']);
  
  // Parse combo requirements like "HAS:AMLOD AND HAS:ATORVAST"
  const hasMatches = comboReq.match(/HAS:([A-Z0-9-]+)/gi) || [];
  const requiredDrugs = hasMatches.map(m => m.replace('HAS:', '').toUpperCase());
  
  if (requiredDrugs.length < 2) return opportunities;
  
  for (const [patientId, patientData] of patientRxMap) {
    const { prescriptions, bin, group } = patientData;
    
    // Check BIN restriction
    if (!binMatches(bin, trigger['BIN Restriction'])) continue;
    
    // Check Group restriction
    if (!groupMatches(group, trigger['Group Restriction'], bin)) continue;
    
    // Get GP for this BIN
    const gp = getGPForBin(trigger, bin);
    if (gp === null) continue;
    
    // Check if patient has ALL required drugs
    const allDrugNames = prescriptions.map(rx => (rx.drug_name || '').toUpperCase()).join(' ');
    
    const hasAllRequired = requiredDrugs.every(drug => allDrugNames.includes(drug));
    if (!hasAllRequired) continue;
    
    // Check exclusions - patient should NOT already have the combo drug
    const hasExcluded = excludeKeywords.some(kw => allDrugNames.includes(kw));
    if (hasExcluded) continue;
    
    // Find first triggering prescription
    const triggeringRx = prescriptions.find(rx => 
      requiredDrugs.some(drug => (rx.drug_name || '').toUpperCase().includes(drug))
    );
    
    if (!triggeringRx) continue;
    
    // Create opportunity
    opportunities.push({
      pharmacy_id,
      patient_id: patientId,
      prescription_id: triggeringRx.prescription_id,
      trigger_id: trigger['Trigger ID'],
      opportunity_type: mapCategoryToType(trigger['Category']),
      category: trigger['Category'] || 'Pill Count',
      current_ndc: triggeringRx.ndc,
      current_drug_name: `Combo Match`,
      recommended_drug_name: trigger['Recommended Med'],
      potential_margin_gain: gp,
      annual_fills: parseInt(trigger['Annual Fills']) || 12,
      clinical_rationale: trigger['Display Name'],
      action: trigger['Action'],
      clinical_priority: (trigger['Priority'] || 'HIGH').toUpperCase(),
      bin,
      group,
      prescriber_name: triggeringRx.prescriber_name,
    });
  }
  
  return opportunities;
}

// ============================================
// MAIN SCANNER
// ============================================

async function runTriggerScanner(clientEmail, triggerCsvPath) {
  console.log(`\n🚀 Running Trigger Scanner for ${clientEmail}...\n`);
  
  // Get pharmacy info
  const clientResult = await pool.query(`
    SELECT c.client_id, p.pharmacy_id, c.client_name
    FROM clients c JOIN pharmacies p ON p.client_id = c.client_id
    WHERE c.submitter_email = $1
  `, [clientEmail.toLowerCase()]);
  
  if (clientResult.rows.length === 0) {
    throw new Error(`Client not found: ${clientEmail}`);
  }
  
  const { pharmacy_id, client_name } = clientResult.rows[0];
  console.log(`📦 Pharmacy: ${client_name}`);
  
  // Load triggers
  console.log(`📋 Loading triggers from: ${triggerCsvPath}`);
  const triggers = loadTriggers(triggerCsvPath);
  console.log(`   Loaded ${triggers.length} enabled triggers\n`);
  
  // Get all recent prescriptions grouped by patient
  console.log('💊 Loading prescription data...');
  const rxResult = await pool.query(`
    SELECT 
      pr.prescription_id,
      pr.patient_id,
      pr.ndc,
      pr.drug_name,
      pr.prescriber_name,
      pr.insurance_bin,
      pr.insurance_group,
      pr.dispensed_date,
      p.primary_insurance_bin,
      p.primary_insurance_pcn
    FROM prescriptions pr
    JOIN patients p ON p.patient_id = pr.patient_id
    WHERE pr.pharmacy_id = $1
      AND pr.dispensed_date > NOW() - INTERVAL '365 days'
    ORDER BY pr.patient_id, pr.dispensed_date DESC
  `, [pharmacy_id]);
  
  console.log(`   Found ${rxResult.rows.length} prescriptions\n`);
  
  // Group by patient
  const patientRxMap = new Map();
  for (const rx of rxResult.rows) {
    if (!patientRxMap.has(rx.patient_id)) {
      patientRxMap.set(rx.patient_id, {
        prescriptions: [],
        bin: rx.insurance_bin || rx.primary_insurance_bin || '',
        group: rx.insurance_group || '',
      });
    }
    patientRxMap.get(rx.patient_id).prescriptions.push(rx);
  }
  
  console.log(`   ${patientRxMap.size} unique patients\n`);
  
  // Process each trigger
  const allOpportunities = [];
  
  for (const trigger of triggers) {
    const triggerType = (trigger['Trigger Type'] || 'STANDARD').toUpperCase();
    const triggerId = trigger['Trigger ID'];
    
    let opps = [];
    
    if (triggerType === 'STANDARD') {
      opps = await processStandardTrigger(trigger, pharmacy_id, patientRxMap);
    } else if (triggerType === 'CONDITIONAL') {
      opps = await processConditionalTrigger(trigger, pharmacy_id, patientRxMap);
    } else if (triggerType === 'COMBO') {
      opps = await processComboTrigger(trigger, pharmacy_id, patientRxMap);
    }
    
    if (opps.length > 0) {
      console.log(`   ✓ ${triggerId}: ${opps.length} opportunities`);
      allOpportunities.push(...opps);
    }
  }
  
  console.log(`\n💾 Saving ${allOpportunities.length} opportunities to database...`);
  
  // Deduplicate by patient + trigger (keep highest value)
  const dedupKey = (opp) => `${opp.patient_id}|${opp.trigger_id}`;
  const dedupMap = new Map();
  for (const opp of allOpportunities) {
    const key = dedupKey(opp);
    if (!dedupMap.has(key) || dedupMap.get(key).potential_margin_gain < opp.potential_margin_gain) {
      dedupMap.set(key, opp);
    }
  }
  
  const uniqueOpps = Array.from(dedupMap.values());
  console.log(`   ${uniqueOpps.length} unique opportunities after deduplication`);
  
  // FIRST: Delete existing 'Not Submitted' opportunities for this pharmacy to avoid duplicates on re-run
  // We only delete 'Not Submitted' status - Submitted/Approved/Completed opportunities are preserved
  const deleteResult = await pool.query(`
    DELETE FROM opportunities 
    WHERE pharmacy_id = $1 AND status = 'Not Submitted'
  `, [pharmacy_id]);
  console.log(`   Cleared ${deleteResult.rowCount} existing unactioned opportunities`);
  
  // Insert opportunities
  let inserted = 0;
  let errors = 0;
  
  for (const opp of uniqueOpps) {
    try {
      await pool.query(`
        INSERT INTO opportunities (
          opportunity_id, pharmacy_id, patient_id, prescription_id, opportunity_type,
          current_ndc, current_drug_name, recommended_drug_name,
          potential_margin_gain, annual_margin_gain,
          clinical_rationale, clinical_priority, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        uuidv4(),
        opp.pharmacy_id,
        opp.patient_id,
        opp.prescription_id,
        opp.opportunity_type,
        opp.current_ndc,
        opp.current_drug_name,
        opp.recommended_drug_name,
        opp.potential_margin_gain,
        opp.potential_margin_gain * opp.annual_fills,
        `${opp.clinical_rationale}\n\nAction: ${opp.action}`,
        opp.clinical_priority.toLowerCase(),
        'Not Submitted'
      ]);
      inserted++;
    } catch (error) {
      errors++;
      if (errors <= 3) {
        console.error(`   Error: ${error.message}`);
      }
    }
  }
  
  // Calculate totals
  const totals = await pool.query(`
    SELECT 
      COUNT(*) as total_opportunities,
      SUM(potential_margin_gain) as monthly_margin,
      SUM(annual_margin_gain) as annual_margin
    FROM opportunities 
    WHERE pharmacy_id = $1 AND status = 'Not Submitted'
  `, [pharmacy_id]);
  
  const stats = totals.rows[0];
  
  console.log(`\n✅ Scanner complete!`);
  console.log(`   📊 Opportunities created: ${inserted}`);
  console.log(`   💰 Total opportunities: ${stats.total_opportunities}`);
  console.log(`   💵 Monthly margin: $${parseFloat(stats.monthly_margin || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}`);
  console.log(`   📅 Annual margin: $${parseFloat(stats.annual_margin || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}`);
  
  return { inserted, stats };
}

// ============================================
// CLI
// ============================================
const args = process.argv.slice(2);

if (args.length < 1) {
  console.log('\nUsage: node run-triggers.js <client-email> [trigger-csv-path]\n');
  console.log('Example:');
  console.log('  node run-triggers.js contact@mybravorx.com ./triggers.csv');
  console.log('  node run-triggers.js michaelbakerrph@gmail.com\n');
  process.exit(1);
}

const clientEmail = args[0];
const triggerPath = args[1] || './triggers.csv';

if (!fs.existsSync(triggerPath)) {
  console.error(`\n❌ Trigger file not found: ${triggerPath}`);
  console.error('Please provide a valid path to your trigger CSV file.\n');
  process.exit(1);
}

runTriggerScanner(clientEmail, triggerPath)
  .then(() => {
    console.log('\n🎉 Done!\n');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Scanner failed:', err.message);
    process.exit(1);
  });
