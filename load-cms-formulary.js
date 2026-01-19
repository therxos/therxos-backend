/**
 * Load CMS Medicare Part D Formulary Data
 * Parses the CMS SPUF files and loads into database
 */

import 'dotenv/config';
import fs from 'fs';
import readline from 'readline';
import db from './src/database/index.js';

const CMS_DATA_DIR = './cms_data/extracted';
const BATCH_SIZE = 1000;
const DATA_YEAR = 2026;

async function loadPlanInformation() {
  console.log('\n=== Loading Plan Information ===\n');

  const filePath = `${CMS_DATA_DIR}/plan information  PPUF_2025Q3.txt`;

  if (!fs.existsSync(filePath)) {
    console.error('Plan information file not found:', filePath);
    return 0;
  }

  // Clear existing data
  await db.query('DELETE FROM cms_plan_formulary WHERE data_year = $1', [DATA_YEAR]);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNum = 0;
  let batch = [];
  let totalInserted = 0;
  let headers = [];

  for await (const line of rl) {
    lineNum++;

    if (lineNum === 1) {
      headers = line.split('|');
      console.log('Headers:', headers.join(', '));
      continue;
    }

    const values = line.split('|');
    if (values.length < 6) continue;

    batch.push({
      contract_id: values[0],
      plan_id: values[1],
      segment_id: values[2],
      contract_name: values[3]?.substring(0, 255),
      plan_name: values[4]?.substring(0, 255),
      formulary_id: values[5],
      premium: parseFloat(values[6]) || 0,
      deductible: parseFloat(values[7]) || 0,
      ma_region_code: values[8] || null,
      pdp_region_code: values[9] || null,
      state: values[10] || null,
      county_code: values[11] || null,
      snp: values[12] || null,
      plan_suppressed: values[13] || null
    });

    if (batch.length >= BATCH_SIZE) {
      await insertPlanBatch(batch);
      totalInserted += batch.length;
      process.stdout.write(`\r  Inserted ${totalInserted.toLocaleString()} plan records...`);
      batch = [];
    }
  }

  // Insert remaining
  if (batch.length > 0) {
    await insertPlanBatch(batch);
    totalInserted += batch.length;
  }

  console.log(`\n  Total plan records: ${totalInserted.toLocaleString()}`);
  return totalInserted;
}

async function insertPlanBatch(batch) {
  const values = [];
  const placeholders = [];
  let paramNum = 1;

  for (const row of batch) {
    placeholders.push(`($${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++})`);
    values.push(
      row.contract_id, row.plan_id, row.segment_id, row.contract_name, row.plan_name,
      row.formulary_id, row.premium, row.deductible, row.ma_region_code, row.pdp_region_code,
      row.state, row.county_code, row.snp, row.plan_suppressed, DATA_YEAR
    );
  }

  await db.query(`
    INSERT INTO cms_plan_formulary (
      contract_id, plan_id, segment_id, contract_name, plan_name,
      formulary_id, premium, deductible, ma_region_code, pdp_region_code,
      state, county_code, snp, plan_suppressed, data_year
    ) VALUES ${placeholders.join(', ')}
    ON CONFLICT (contract_id, plan_id, formulary_id, county_code) DO UPDATE SET
      plan_name = EXCLUDED.plan_name,
      premium = EXCLUDED.premium,
      deductible = EXCLUDED.deductible
  `, values);
}

async function loadFormularyDrugs() {
  console.log('\n=== Loading Formulary Drug Coverage ===\n');

  const filePath = `${CMS_DATA_DIR}/basic drugs formulary file  PPUF_2025Q3.txt`;

  if (!fs.existsSync(filePath)) {
    console.error('Formulary file not found:', filePath);
    return 0;
  }

  // Clear existing data
  await db.query('DELETE FROM cms_formulary_drugs WHERE data_year = $1', [DATA_YEAR]);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNum = 0;
  let batch = [];
  let totalInserted = 0;
  let headers = [];

  for await (const line of rl) {
    lineNum++;

    if (lineNum === 1) {
      headers = line.split('|');
      console.log('Headers:', headers.join(', '));
      continue;
    }

    const values = line.split('|');
    if (values.length < 6) continue;

    // Normalize NDC to 11 digits
    let ndc = (values[4] || '').replace(/[^0-9]/g, '').padStart(11, '0');

    batch.push({
      formulary_id: values[0],
      formulary_version: parseInt(values[1]) || null,
      contract_year: parseInt(values[2]) || null,
      rxcui: values[3] || null,
      ndc: ndc,
      tier_level: parseInt(values[5]) || null,
      quantity_limit_yn: values[6] === 'Y',
      quantity_limit_amount: parseFloat(values[7]) || null,
      quantity_limit_days: parseInt(values[8]) || null,
      prior_authorization_yn: values[9] === 'Y',
      step_therapy_yn: values[10] === 'Y'
    });

    if (batch.length >= BATCH_SIZE) {
      await insertFormularyBatch(batch);
      totalInserted += batch.length;
      process.stdout.write(`\r  Inserted ${totalInserted.toLocaleString()} formulary records...`);
      batch = [];
    }
  }

  // Insert remaining
  if (batch.length > 0) {
    await insertFormularyBatch(batch);
    totalInserted += batch.length;
  }

  console.log(`\n  Total formulary records: ${totalInserted.toLocaleString()}`);
  return totalInserted;
}

async function insertFormularyBatch(batch) {
  const values = [];
  const placeholders = [];
  let paramNum = 1;

  for (const row of batch) {
    placeholders.push(`($${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++}, $${paramNum++})`);
    values.push(
      row.formulary_id, row.formulary_version, row.contract_year, row.rxcui, row.ndc,
      row.tier_level, row.quantity_limit_yn, row.quantity_limit_amount, row.quantity_limit_days,
      row.prior_authorization_yn, row.step_therapy_yn, DATA_YEAR
    );
  }

  await db.query(`
    INSERT INTO cms_formulary_drugs (
      formulary_id, formulary_version, contract_year, rxcui, ndc,
      tier_level, quantity_limit_yn, quantity_limit_amount, quantity_limit_days,
      prior_authorization_yn, step_therapy_yn, data_year
    ) VALUES ${placeholders.join(', ')}
    ON CONFLICT (formulary_id, ndc) DO UPDATE SET
      tier_level = EXCLUDED.tier_level,
      prior_authorization_yn = EXCLUDED.prior_authorization_yn,
      step_therapy_yn = EXCLUDED.step_therapy_yn,
      quantity_limit_yn = EXCLUDED.quantity_limit_yn,
      quantity_limit_amount = EXCLUDED.quantity_limit_amount,
      quantity_limit_days = EXCLUDED.quantity_limit_days
  `, values);
}

async function verifyData() {
  console.log('\n=== Verifying Data ===\n');

  // Check counts
  const planCount = await db.query('SELECT COUNT(*) as cnt FROM cms_plan_formulary WHERE data_year = $1', [DATA_YEAR]);
  const drugCount = await db.query('SELECT COUNT(*) as cnt FROM cms_formulary_drugs WHERE data_year = $1', [DATA_YEAR]);

  console.log(`  Plan records: ${parseInt(planCount.rows[0].cnt).toLocaleString()}`);
  console.log(`  Drug records: ${parseInt(drugCount.rows[0].cnt).toLocaleString()}`);

  // Check unique contracts
  const contracts = await db.query(`
    SELECT COUNT(DISTINCT contract_id || '-' || plan_id) as cnt
    FROM cms_plan_formulary WHERE data_year = $1
  `, [DATA_YEAR]);
  console.log(`  Unique contract/plan combinations: ${parseInt(contracts.rows[0].cnt).toLocaleString()}`);

  // Check unique formularies
  const formularies = await db.query(`
    SELECT COUNT(DISTINCT formulary_id) as cnt
    FROM cms_plan_formulary WHERE data_year = $1
  `, [DATA_YEAR]);
  console.log(`  Unique formularies: ${parseInt(formularies.rows[0].cnt).toLocaleString()}`);

  // Test lookup for H2226-001
  console.log('\n  Testing lookup for H2226-001...');
  const testPlan = await db.query(`
    SELECT DISTINCT contract_id, plan_id, plan_name, formulary_id
    FROM cms_plan_formulary
    WHERE contract_id = 'H2226' AND plan_id = '001'
    LIMIT 1
  `);

  if (testPlan.rows.length > 0) {
    const plan = testPlan.rows[0];
    console.log(`    Plan: ${plan.plan_name}`);
    console.log(`    Formulary ID: ${plan.formulary_id}`);

    // Count drugs in this formulary
    const drugCount = await db.query(`
      SELECT COUNT(*) as cnt FROM cms_formulary_drugs WHERE formulary_id = $1
    `, [plan.formulary_id]);
    console.log(`    Drugs covered: ${parseInt(drugCount.rows[0].cnt).toLocaleString()}`);
  } else {
    console.log('    H2226-001 not found in data');
  }
}

async function main() {
  console.log('=== CMS Medicare Part D Formulary Loader ===');
  console.log(`Data year: ${DATA_YEAR}`);

  const startTime = Date.now();

  try {
    await loadPlanInformation();
    await loadFormularyDrugs();
    await verifyData();

    const duration = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n=== Complete in ${duration} seconds ===\n`);
  } catch (error) {
    console.error('\nError:', error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

main();
