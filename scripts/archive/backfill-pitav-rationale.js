import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const TRIGGER_ID = 'd806cf01-dc89-416b-abe5-af71d3c39f59';
const FULL_RATIONALE = 'Pitavastatin provides comparable LDL-C lowering efficacy to other moderate-intensity statins with a favorable drug interaction profile, as it is not metabolized by CYP3A4, reducing the risk of adverse effects from common interactions. This interchange supports guideline-directed statin therapy while potentially improving patient safety and tolerability.';

// Update all opportunities for this trigger that have the short fallback rationale
const result = await pool.query(`
  UPDATE opportunities
  SET clinical_rationale = $1, updated_at = NOW()
  WHERE trigger_id = $2
    AND (
      clinical_rationale IS NULL
      OR clinical_rationale LIKE '%opportunity%'
      OR clinical_rationale LIKE '%missing Opportunity%'
      OR LENGTH(clinical_rationale) < 100
    )
  RETURNING opportunity_id, status
`, [FULL_RATIONALE, TRIGGER_ID]);

console.log(`Updated ${result.rows.length} Pitavastatin opportunities with full clinical rationale`);

const statusBreakdown = {};
result.rows.forEach(r => { statusBreakdown[r.status] = (statusBreakdown[r.status] || 0) + 1; });
console.log('By status:', statusBreakdown);

await pool.end();
