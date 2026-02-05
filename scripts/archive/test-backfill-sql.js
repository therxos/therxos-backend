import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  const triggerId = '5e0ed397-04ab-4bd8-adb7-47caaa71db37';

  try {
    const result = await pool.query(`
      UPDATE opportunities o SET
        annual_margin_gain = ROUND(
          COALESCE(
            (SELECT tbv.gp_value
             FROM prescriptions rx
             JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
               AND tbv.insurance_bin = rx.insurance_bin
               AND COALESCE(tbv.insurance_group, '') = COALESCE(rx.insurance_group, '')
               AND tbv.is_excluded = false
             WHERE rx.prescription_id = o.prescription_id
             LIMIT 1),
            $2
          ) * COALESCE($3, 12), 2
        ),
        updated_at = NOW()
      WHERE o.trigger_id = $1
        AND o.status = 'Not Submitted'
    `, [triggerId, 82, 12]);
    console.log('Success:', result.rowCount, 'rows updated');
  } catch (err) {
    console.error('SQL Error:', err.message);
    console.error('Code:', err.code);
  }

  await pool.end();
}

main();
