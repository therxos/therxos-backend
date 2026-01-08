// migrate-triggers.js - Import triggers from UNIVERSAL_TRIGGER.csv to database
// Run with: node scripts/migrate-triggers.js

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

// BIN columns in the CSV
const BIN_COLUMNS = [
  { column: 'New GP - 610097', bin: '610097' },
  { column: 'New GP - 610011', bin: '610011' },
  { column: 'New GP - 610014', bin: '610014' },
  { column: 'New GP - 004336', bin: '004336' },
  { column: 'New GP - 610502', bin: '610502' },
  { column: 'New GP - 015581', bin: '015581' },
  { column: 'New GP - 003858', bin: '003858' },
  { column: 'New GP - 610494', bin: '610494' },
  { column: 'New GP - 009555', bin: '009555' },
  { column: 'New GP - 610239', bin: '610239' },
  { column: 'New GP - 020115', bin: '020115' },
];

// Map CSV trigger type to database type
function mapTriggerType(csvType, hasIfHas, hasIfNotHas) {
  // CONDITIONAL usually means missing therapy
  if (csvType === 'CONDITIONAL') return 'missing_therapy';
  // COMBO is still a therapeutic change
  if (csvType === 'COMBO') return 'therapeutic_interchange';
  // STANDARD with IF_NOT_HAS is missing therapy
  if (hasIfNotHas && !hasIfHas) return 'missing_therapy';
  // Default to therapeutic interchange
  return 'therapeutic_interchange';
}

// Map category to our standard categories
function mapCategory(category) {
  if (!category) return null;
  const cat = category.toLowerCase();
  if (cat.includes('ndc')) return 'NDC Optimization';
  if (cat.includes('therapeutic') || cat.includes('alt')) return 'Therapeutic Interchange';
  if (cat.includes('missing') || cat.includes('add-on') || cat.includes('addon')) return 'Missing Therapy';
  if (cat.includes('formulation')) return 'Formulation Change';
  if (cat.includes('diabetic') || cat.includes('supply')) return 'Diabetic Supplies';
  if (cat.includes('glp')) return 'GLP-1 Support';
  return category;
}

// Parse comma-separated keywords
function parseKeywords(str) {
  if (!str || str.trim() === '') return [];
  return str.split(',')
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0);
}

// Parse GP value from CSV
function parseGPValue(str) {
  if (!str || str === 'EXCLUDE' || str.trim() === '') return null;
  const cleaned = str.replace(/[$,]/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// Parse BIN restriction string
function parseBinRestriction(str) {
  if (!str || str.trim() === '') return { type: null, bins: [] };
  str = str.trim().toUpperCase();

  if (str === 'ALL') return { type: null, bins: [] }; // No restriction

  if (str.startsWith('ONLY ')) {
    const bins = str.replace('ONLY ', '').split(',').map(b => b.trim()).filter(Boolean);
    return { type: 'bin_only', bins };
  }

  if (str.startsWith('ALL EXCEPT ')) {
    const bins = str.replace('ALL EXCEPT ', '').split(',').map(b => b.trim()).filter(Boolean);
    return { type: 'bin_exclude', bins };
  }

  // If it's just bins listed, treat as ONLY
  const bins = str.split(',').map(b => b.trim()).filter(Boolean);
  if (bins.length > 0 && bins[0].match(/^\d{6}$/)) {
    return { type: 'bin_only', bins };
  }

  return { type: null, bins: [] };
}

// Parse Group restriction - can have BIN-specific rules
function parseGroupRestriction(str, binRestriction) {
  if (!str || str.trim() === '') return [];

  const restrictions = [];
  const parts = str.split(',').map(p => p.trim());

  // Check for BIN-specific group rules (e.g., "610097:ONLY COS")
  for (const part of parts) {
    if (part.includes(':')) {
      const [bin, rule] = part.split(':').map(s => s.trim());
      if (rule.startsWith('ONLY ')) {
        const groups = rule.replace('ONLY ', '').split(',').map(g => g.trim());
        restrictions.push({ bin, type: 'group_only', groups });
      } else if (rule.startsWith('ALL EXCEPT ')) {
        const groups = rule.replace('ALL EXCEPT ', '').split(',').map(g => g.trim());
        restrictions.push({ bin, type: 'group_exclude', groups });
      } else {
        const groups = rule.split(' ').filter(g => g.length > 0);
        restrictions.push({ bin, type: 'group_only', groups });
      }
    }
  }

  // If no BIN-specific rules, check for general rules
  if (restrictions.length === 0) {
    const cleaned = str.toUpperCase();
    if (cleaned.startsWith('ONLY ')) {
      const groups = cleaned.replace('ONLY ', '').split(',').map(g => g.trim());
      restrictions.push({ bin: null, type: 'group_only', groups });
    } else if (cleaned.startsWith('ALL EXCEPT ')) {
      const groups = cleaned.replace('ALL EXCEPT ', '').split(',').map(g => g.trim());
      restrictions.push({ bin: null, type: 'group_exclude', groups });
    } else if (cleaned !== 'ALL') {
      // Just a list of groups
      const groups = cleaned.split(',').map(g => g.trim().split(' ')).flat().filter(g => g.length > 0);
      if (groups.length > 0) {
        restrictions.push({ bin: null, type: 'group_only', groups });
      }
    }
  }

  return restrictions;
}

async function migrateTriggers() {
  console.log('Starting trigger migration...\n');

  // Read CSV file
  const csvPath = path.join(__dirname, '..', 'UNIVERSAL_TRIGGER.csv');
  const csvContent = fs.readFileSync(csvPath, 'utf-8');

  // Parse CSV
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
    relax_column_count: true,
  });

  console.log(`Found ${records.length} triggers in CSV\n`);

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of records) {
    const triggerCode = row['Trigger ID']?.trim();
    if (!triggerCode) {
      console.log('Skipping row with no Trigger ID');
      skipped++;
      continue;
    }

    console.log(`Processing: ${triggerCode}`);

    try {
      // Check if already exists
      const existing = await pool.query(
        'SELECT trigger_id FROM triggers WHERE trigger_code = $1',
        [triggerCode]
      );

      if (existing.rows.length > 0) {
        console.log(`  -> Already exists, skipping`);
        skipped++;
        continue;
      }

      // Parse fields
      const displayName = row['Display Name']?.trim() || triggerCode;
      const enabled = row['Enabled']?.toUpperCase() === 'TRUE';
      const csvType = row['Trigger Type']?.trim() || 'STANDARD';
      const detectionKeywords = parseKeywords(row['Detection Keywords']);
      const excludeKeywords = parseKeywords(row['Exclude Keywords']);
      const recommendedDrug = row['Recommended Med']?.trim() || null;
      const ifHasKeywords = parseKeywords(row['IF_HAS']);
      const ifNotHasKeywords = parseKeywords(row['IF_NOT_HAS']);
      const annualFills = parseInt(row['Annual Fills']) || 12;
      const action = row['Action']?.trim() || null;
      const category = mapCategory(row['Category']?.trim());
      const priority = (row['Priority']?.trim()?.toLowerCase()) || 'medium';
      const notes = row['Notes']?.trim() || null;

      // Determine trigger type
      const triggerType = mapTriggerType(csvType, ifHasKeywords.length > 0, ifNotHasKeywords.length > 0);

      // Check if this is an NDC optimization based on category
      const finalType = category === 'NDC Optimization' ? 'ndc_optimization' : triggerType;

      // Find the first non-EXCLUDE GP value as default
      let defaultGP = null;
      for (const binCol of BIN_COLUMNS) {
        const gp = parseGPValue(row[binCol.column]);
        if (gp !== null) {
          defaultGP = gp;
          break;
        }
      }

      // Insert trigger
      const result = await pool.query(`
        INSERT INTO triggers (
          trigger_code, display_name, trigger_type, category,
          detection_keywords, exclude_keywords, if_has_keywords, if_not_has_keywords,
          recommended_drug, action_instructions, clinical_rationale,
          priority, annual_fills, default_gp_value, is_enabled
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING trigger_id
      `, [
        triggerCode,
        displayName,
        finalType,
        category,
        detectionKeywords.length > 0 ? detectionKeywords : null,
        excludeKeywords.length > 0 ? excludeKeywords : null,
        ifHasKeywords.length > 0 ? ifHasKeywords : null,
        ifNotHasKeywords.length > 0 ? ifNotHasKeywords : null,
        recommendedDrug,
        action,
        notes,
        priority === 'high' || priority === 'medium' || priority === 'low' || priority === 'critical' ? priority : 'medium',
        annualFills,
        defaultGP,
        enabled,
      ]);

      const triggerId = result.rows[0].trigger_id;

      // Insert BIN-specific GP values
      for (const binCol of BIN_COLUMNS) {
        const gpValue = parseGPValue(row[binCol.column]);
        const isExcluded = row[binCol.column]?.trim().toUpperCase() === 'EXCLUDE';

        if (gpValue !== null || isExcluded) {
          await pool.query(`
            INSERT INTO trigger_bin_values (trigger_id, insurance_bin, gp_value, is_excluded)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (trigger_id, insurance_bin) DO UPDATE
            SET gp_value = EXCLUDED.gp_value, is_excluded = EXCLUDED.is_excluded
          `, [triggerId, binCol.bin, gpValue, isExcluded]);
        }
      }

      // Parse and insert BIN restrictions
      const binRestriction = parseBinRestriction(row['BIN Restriction']);
      if (binRestriction.type && binRestriction.bins.length > 0) {
        for (const bin of binRestriction.bins) {
          await pool.query(`
            INSERT INTO trigger_restrictions (trigger_id, restriction_type, insurance_bin)
            VALUES ($1, $2, $3)
          `, [triggerId, binRestriction.type, bin]);
        }
      }

      // Parse and insert Group restrictions
      const groupRestrictions = parseGroupRestriction(row['Group Restriction'], binRestriction);
      for (const gr of groupRestrictions) {
        if (gr.groups.length > 0) {
          await pool.query(`
            INSERT INTO trigger_restrictions (trigger_id, restriction_type, insurance_bin, insurance_groups)
            VALUES ($1, $2, $3, $4)
          `, [triggerId, gr.type, gr.bin, gr.groups]);
        }
      }

      console.log(`  -> Inserted with ${BIN_COLUMNS.filter(c => parseGPValue(row[c.column]) !== null).length} BIN values`);
      inserted++;

    } catch (err) {
      console.error(`  -> ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log('\n========================================');
  console.log(`Migration complete!`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Errors:   ${errors}`);
  console.log('========================================\n');

  await pool.end();
}

migrateTriggers().catch(console.error);
