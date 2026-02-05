import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const r = await pool.query(`
  SELECT opportunity_id, clinical_rationale, trigger_id, status
  FROM opportunities
  WHERE trigger_id = 'd806cf01-dc89-416b-abe5-af71d3c39f59'
  OR LOWER(recommended_drug_name) LIKE '%pitav%'
  OR LOWER(recommended_drug_name) LIKE '%pitiv%'
  LIMIT 15
`);

console.log('Total:', r.rows.length);
r.rows.forEach(o => {
  const rat = (o.clinical_rationale || 'NULL').substring(0, 80);
  console.log(`${o.opportunity_id.substring(0,8)} | ${o.trigger_id ? 'TRIGGER' : 'LEGACY'} | ${o.status.padEnd(15)} | ${rat}`);
});

await pool.end();
