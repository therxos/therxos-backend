import 'dotenv/config';
import pg from 'pg';
import copyFrom from 'pg-copy-streams';

const prodUrl = process.env.DATABASE_URL;
const stagingUrl = 'postgresql://postgres:rX%40pharmacystan@db.vnbsvoxmnakzcdnbhabc.supabase.co:5432/postgres';

const prodPool = new pg.Pool({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } });
const stagingPool = new pg.Pool({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });

async function copyTable(tableName) {
  const prodClient = await prodPool.connect();
  const stagingClient = await stagingPool.connect();

  try {
    // Get count
    const countRes = await prodClient.query(`SELECT COUNT(*) as cnt FROM ${tableName}`);
    const count = parseInt(countRes.rows[0].cnt);
    if (count === 0) {
      console.log(`  ${tableName}: 0 rows (skipped)`);
      return 0;
    }

    // Truncate staging table
    await stagingClient.query(`TRUNCATE ${tableName} CASCADE`);

    // Use COPY to export from prod and import to staging
    return new Promise((resolve, reject) => {
      const copyToStream = prodClient.query(copyFrom.to(`COPY ${tableName} TO STDOUT`));
      const copyFromStream = stagingClient.query(copyFrom.from(`COPY ${tableName} FROM STDIN`));

      copyToStream.on('error', reject);
      copyFromStream.on('error', reject);
      copyFromStream.on('finish', () => {
        console.log(`  ✅ ${tableName}: ${count} rows`);
        resolve(count);
      });

      copyToStream.pipe(copyFromStream);
    });
  } finally {
    prodClient.release();
    stagingClient.release();
  }
}

async function main() {
  console.log('🚀 Fast copy to staging using COPY protocol...\n');

  const tables = [
    'triggers',
    'trigger_bin_values',
    'trigger_restrictions',
    'opportunities',
    'prescriptions',
    'audit_rules',
    'scan_logs'
  ];

  for (const table of tables) {
    try {
      await copyTable(table);
    } catch (err) {
      console.log(`  ⚠️ ${table}: ${err.message.slice(0, 50)}`);
    }
  }

  // Verify
  console.log('\n📊 Staging DB final status:');
  const checkTables = ['clients', 'pharmacies', 'users', 'patients', 'prescriptions', 'opportunities', 'triggers'];
  for (const t of checkTables) {
    const r = await stagingPool.query(`SELECT COUNT(*) as cnt FROM ${t}`);
    console.log(`  ${t}: ${r.rows[0].cnt}`);
  }

  await prodPool.end();
  await stagingPool.end();
  console.log('\n✅ Done!');
}

main().catch(console.error);
