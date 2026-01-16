import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  // Check formulary_items structure and data
  const formulary = await pool.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'formulary_items'
    ORDER BY ordinal_position
  `);
  console.log('formulary_items columns:');
  formulary.rows.forEach(r => console.log('  ' + r.column_name + ' (' + r.data_type + ')'));

  const formularyCount = await pool.query('SELECT COUNT(*) as cnt FROM formulary_items');
  console.log('\nformulary_items count: ' + formularyCount.rows[0].cnt);

  if (formularyCount.rows[0].cnt > 0) {
    const formularySample = await pool.query('SELECT * FROM formulary_items LIMIT 3');
    console.log('\nSample rows:');
    console.log(JSON.stringify(formularySample.rows, null, 2));
  }

  // Check ndc_reference for any state-specific data
  const ndcCols = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'ndc_reference'
  `);
  console.log('\nndc_reference columns:');
  ndcCols.rows.forEach(r => console.log('  ' + r.column_name));

  // Check trigger_bin_values for Medicaid payers
  const medicaidBins = await pool.query(`
    SELECT DISTINCT bin, pcn, plan_name
    FROM trigger_bin_values
    WHERE LOWER(plan_name) LIKE '%medicaid%' OR LOWER(plan_name) LIKE '%state%'
    LIMIT 20
  `);
  console.log('\nMedicaid-related BIN/PCN values:');
  medicaidBins.rows.forEach(r => console.log('  ' + r.bin + '/' + r.pcn + ': ' + r.plan_name));

  await pool.end();
}

run().catch(console.error);
