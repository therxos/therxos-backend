import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function check() {
  // Check prescriber data in prescriptions
  const prescriberData = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(prescriber_name) as with_name,
      COUNT(prescriber_npi) as with_npi
    FROM prescriptions WHERE pharmacy_id = $1
  `, [pharmacyId]);

  console.log('Prescriber data in prescriptions:');
  console.log(prescriberData.rows[0]);

  // Sample prescriber names
  const sample = await pool.query(`
    SELECT DISTINCT prescriber_name, prescriber_npi, COUNT(*) as rx_count
    FROM prescriptions
    WHERE pharmacy_id = $1 AND prescriber_name IS NOT NULL
    GROUP BY prescriber_name, prescriber_npi
    ORDER BY COUNT(*) DESC
    LIMIT 15
  `, [pharmacyId]);

  console.log('\nTop prescribers by Rx count:');
  for (const r of sample.rows) {
    console.log(`  ${(r.prescriber_name || '').padEnd(30)} | NPI: ${r.prescriber_npi || 'N/A'} | ${r.rx_count} Rx`);
  }

  // Check opportunities prescriber_name column
  const oppPrescriberData = await pool.query(`
    SELECT
      COUNT(*) as total,
      COUNT(prescriber_name) as with_name
    FROM opportunities WHERE pharmacy_id = $1
  `, [pharmacyId]);

  console.log('\nPrescriber data in opportunities:');
  console.log(`  Total: ${oppPrescriberData.rows[0].total}, With prescriber: ${oppPrescriberData.rows[0].with_name}`);

  await pool.end();
}

check().catch(console.error);
