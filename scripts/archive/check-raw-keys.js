import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Get one raw_data sample per pharmacy to see the keys
  const result = await pool.query(`
    SELECT DISTINCT ON (ph.pharmacy_name)
      ph.pharmacy_name, rx.raw_data, rx.source_file
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    WHERE rx.raw_data IS NOT NULL
    ORDER BY ph.pharmacy_name, rx.created_at DESC
  `);

  for (const r of result.rows) {
    console.log(`\n=== ${r.pharmacy_name} (${r.source_file}) ===`);
    if (r.raw_data && typeof r.raw_data === 'object') {
      const keys = Object.keys(r.raw_data);
      console.log('Keys:', keys.join(', '));
      // Show GP-related values
      for (const k of keys) {
        const kl = k.toLowerCase();
        if (kl.includes('profit') || kl.includes('gp') || kl.includes('cost') || kl.includes('pay') || kl.includes('reimburse') || kl.includes('remit') || kl.includes('price') || kl.includes('awp')) {
          console.log(`  ${k}: ${r.raw_data[k]}`);
        }
      }
    } else {
      console.log('raw_data is null or not object');
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
