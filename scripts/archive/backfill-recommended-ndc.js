import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Step 1: Update from BIN-specific best_ndc (correlated subquery for PostgreSQL)
  const binResult = await pool.query(`
    UPDATE opportunities o SET recommended_ndc = (
      SELECT tbv.best_ndc
      FROM prescriptions pr
      JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
        AND tbv.insurance_bin = pr.insurance_bin
        AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, '')
        AND tbv.best_ndc IS NOT NULL
      WHERE pr.prescription_id = o.prescription_id
      LIMIT 1
    )
    WHERE o.recommended_ndc IS NULL
      AND o.trigger_id IS NOT NULL
      AND o.prescription_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM prescriptions pr
        JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
          AND tbv.insurance_bin = pr.insurance_bin
          AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, '')
          AND tbv.best_ndc IS NOT NULL
        WHERE pr.prescription_id = o.prescription_id
      )
  `);
  console.log(`Updated ${binResult.rowCount} opportunities with BIN-specific best_ndc`);

  // Step 2: Update remaining from trigger-level recommended_ndc
  const triggerResult = await pool.query(`
    UPDATE opportunities o SET recommended_ndc = t.recommended_ndc
    FROM triggers t
    WHERE t.trigger_id = o.trigger_id
      AND o.recommended_ndc IS NULL
      AND t.recommended_ndc IS NOT NULL
  `);
  console.log(`Updated ${triggerResult.rowCount} opportunities with trigger-level recommended_ndc`);

  // Verify
  const stats = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(recommended_ndc) as has_ndc,
      COUNT(*) - COUNT(recommended_ndc) as missing_ndc
    FROM opportunities
  `);
  console.log('\nFinal stats:', stats.rows[0]);

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
