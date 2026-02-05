import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Check source files for Bravo
  const sources = await pool.query(`
    SELECT rx.source_file, rx.source, COUNT(*) as cnt
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    WHERE ph.pharmacy_name ILIKE '%bravo%'
    GROUP BY rx.source_file, rx.source
    ORDER BY cnt DESC
  `);
  console.log('Bravo source files:');
  sources.rows.forEach(r => console.log(`  ${r.source_file || '(null)'} [${r.source}]: ${r.cnt} rows`));

  // Check raw_data keys for non-SPP Bravo records
  const sample = await pool.query(`
    SELECT rx.raw_data, rx.source_file
    FROM prescriptions rx
    JOIN pharmacies ph ON ph.pharmacy_id = rx.pharmacy_id
    WHERE ph.pharmacy_name ILIKE '%bravo%'
    AND (rx.source_file IS NULL OR rx.source_file NOT ILIKE '%spp%')
    AND rx.raw_data IS NOT NULL
    LIMIT 1
  `);

  if (sample.rows.length > 0) {
    const r = sample.rows[0];
    console.log(`\nNon-SPP Bravo raw_data (source: ${r.source_file}):`);
    const keys = Object.keys(r.raw_data);
    console.log('Keys:', keys.join(', '));
    for (const k of keys) {
      const kl = k.toLowerCase();
      if (kl.includes('profit') || kl.includes('cost') || kl.includes('pay') || kl.includes('reimburse') || kl.includes('awp') || kl.includes('price')) {
        console.log(`  ${k}: ${r.raw_data[k]}`);
      }
    }
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
