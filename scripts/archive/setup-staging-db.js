import 'dotenv/config';
import pg from 'pg';

const prodUrl = process.env.DATABASE_URL;
const stagingUrl = 'postgresql://postgres:rX%40pharmacystan@db.vnbsvoxmnakzcdnbhabc.supabase.co:5432/postgres';

const prodPool = new pg.Pool({ connectionString: prodUrl, ssl: { rejectUnauthorized: false } });
const stagingPool = new pg.Pool({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });

async function setup() {
  console.log('🚀 Setting up staging database...\n');

  // Step 1: Get all table definitions from prod
  console.log('📋 Getting schema from production...');

  const tablesResult = await prodPool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);

  const tables = tablesResult.rows.map(r => r.table_name);
  console.log(`   Found ${tables.length} tables: ${tables.join(', ')}\n`);

  // Step 2: Create schema in staging
  console.log('🔨 Creating tables in staging...');

  // Get and run CREATE TABLE statements
  for (const table of tables) {
    try {
      // Get column definitions
      const colsResult = await prodPool.query(`
        SELECT
          column_name,
          data_type,
          udt_name,
          is_nullable,
          column_default,
          character_maximum_length
        FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'
        ORDER BY ordinal_position
      `, [table]);

      if (colsResult.rows.length === 0) continue;

      // Build CREATE TABLE statement
      const columns = colsResult.rows.map(col => {
        let type = col.data_type;
        if (type === 'ARRAY') type = col.udt_name;
        if (type === 'character varying' && col.character_maximum_length) {
          type = `VARCHAR(${col.character_maximum_length})`;
        }
        if (type === 'USER-DEFINED') type = 'TEXT'; // Handle custom types

        let def = `"${col.column_name}" ${type}`;
        if (col.column_default) {
          // Clean up default value
          let defaultVal = col.column_default;
          if (defaultVal.includes('::')) {
            defaultVal = defaultVal.split('::')[0];
          }
          def += ` DEFAULT ${defaultVal}`;
        }
        if (col.is_nullable === 'NO') def += ' NOT NULL';
        return def;
      });

      const createSql = `CREATE TABLE IF NOT EXISTS "${table}" (\n  ${columns.join(',\n  ')}\n)`;

      await stagingPool.query(createSql);
      console.log(`   ✅ ${table}`);
    } catch (err) {
      console.log(`   ⚠️ ${table}: ${err.message.slice(0, 60)}`);
    }
  }

  // Step 3: Copy data
  console.log('\n📦 Copying data to staging...');

  // Order tables for foreign key dependencies
  const orderedTables = [
    'clients', 'pharmacies', 'users', 'patients', 'prescriptions',
    'triggers', 'trigger_bin_values', 'trigger_restrictions',
    'opportunities', 'data_quality_issues', 'audit_rules', 'scan_logs'
  ].filter(t => tables.includes(t));

  // Add any remaining tables
  for (const t of tables) {
    if (!orderedTables.includes(t)) orderedTables.push(t);
  }

  for (const table of orderedTables) {
    try {
      // Get count from prod
      const countResult = await prodPool.query(`SELECT COUNT(*) as cnt FROM "${table}"`);
      const count = parseInt(countResult.rows[0].cnt);

      if (count === 0) {
        console.log(`   ⏭️ ${table}: 0 rows (skipped)`);
        continue;
      }

      // Clear staging table
      await stagingPool.query(`TRUNCATE "${table}" CASCADE`);

      // Get all data from prod
      const data = await prodPool.query(`SELECT * FROM "${table}"`);

      if (data.rows.length === 0) continue;

      // Get column names
      const columns = Object.keys(data.rows[0]);

      // Insert in batches
      let inserted = 0;
      const batchSize = 100;

      for (let i = 0; i < data.rows.length; i += batchSize) {
        const batch = data.rows.slice(i, i + batchSize);

        for (const row of batch) {
          const values = columns.map((col, idx) => `$${idx + 1}`);
          const params = columns.map(col => row[col]);

          try {
            await stagingPool.query(
              `INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${values.join(', ')})`,
              params
            );
            inserted++;
          } catch (insertErr) {
            // Skip individual row errors (likely constraint issues)
          }
        }
      }

      console.log(`   ✅ ${table}: ${inserted}/${count} rows`);
    } catch (err) {
      console.log(`   ⚠️ ${table}: ${err.message.slice(0, 50)}`);
    }
  }

  console.log('\n✅ Staging database setup complete!');
  console.log('\n📝 Staging connection string:');
  console.log('   postgresql://postgres:rX%40pharmacystan@db.vnbsvoxmnakzcdnbhabc.supabase.co:5432/postgres');

  await prodPool.end();
  await stagingPool.end();
}

setup().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
