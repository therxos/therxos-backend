import 'dotenv/config';
import pg from 'pg';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  // 1. Count legacy data quality issues (opportunities without trigger_id)
  const before = await pool.query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE dqi.status = 'pending') as pending
    FROM data_quality_issues dqi
    JOIN opportunities o ON o.opportunity_id = dqi.opportunity_id
    WHERE o.trigger_id IS NULL
  `);
  console.log('Legacy data quality issues:', before.rows[0]);

  // 2. Delete pending data quality issues for legacy opportunities
  const deleted = await pool.query(`
    DELETE FROM data_quality_issues dqi
    USING opportunities o
    WHERE o.opportunity_id = dqi.opportunity_id
      AND o.trigger_id IS NULL
      AND dqi.status = 'pending'
  `);
  console.log('Deleted', deleted.rowCount, 'legacy pending data quality issues');

  // 3. Update the trigger function to only flag trigger-based opportunities
  await pool.query(`
    CREATE OR REPLACE FUNCTION check_opportunity_data_quality()
    RETURNS TRIGGER AS $$
    BEGIN
      -- Only check data quality for trigger-based opportunities (not legacy/V1 scans)
      IF NEW.trigger_id IS NULL THEN
        RETURN NEW;
      END IF;

      -- Check for missing/unknown prescriber
      IF NEW.prescriber_name IS NULL OR UPPER(NEW.prescriber_name) LIKE '%UNKNOWN%' THEN
        INSERT INTO data_quality_issues (
          pharmacy_id, opportunity_id, patient_id, issue_type,
          issue_description, original_value, field_name
        ) VALUES (
          NEW.pharmacy_id, NEW.opportunity_id, NEW.patient_id,
          CASE WHEN NEW.prescriber_name IS NULL THEN 'missing_prescriber' ELSE 'unknown_prescriber' END,
          'Opportunity has missing or unknown prescriber - needs review before showing to client',
          COALESCE(NEW.prescriber_name, 'NULL'),
          'prescriber_name'
        );
      END IF;

      -- Check for missing/unknown current drug
      IF NEW.current_drug_name IS NULL OR UPPER(NEW.current_drug_name) LIKE '%UNKNOWN%' THEN
        INSERT INTO data_quality_issues (
          pharmacy_id, opportunity_id, patient_id, issue_type,
          issue_description, original_value, field_name
        ) VALUES (
          NEW.pharmacy_id, NEW.opportunity_id, NEW.patient_id,
          CASE WHEN NEW.current_drug_name IS NULL THEN 'missing_current_drug' ELSE 'unknown_current_drug' END,
          'Opportunity has missing or unknown current drug - needs review before showing to client',
          COALESCE(NEW.current_drug_name, 'NULL'),
          'current_drug_name'
        );
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  console.log('Updated trigger function to skip legacy opportunities');

  // 4. Show remaining data quality issues
  const after = await pool.query(`
    SELECT status, COUNT(*) as cnt
    FROM data_quality_issues
    GROUP BY status
    ORDER BY cnt DESC
  `);
  console.log('\nRemaining data quality issues:');
  for (const r of after.rows) {
    console.log(`  ${r.status}: ${r.cnt}`);
  }

  await pool.end();
}
run();
