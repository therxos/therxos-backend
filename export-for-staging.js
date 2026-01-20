// Export prod data for staging environment
// Run with: node export-for-staging.js
// Then import to staging DB with: psql $STAGING_DATABASE_URL < staging-export.sql

import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function exportData() {
  console.log('Exporting data for staging environment...\n');

  // Tables to export (in order for foreign key dependencies)
  const tables = [
    'clients',
    'pharmacies',
    'users',
    'patients',
    'prescriptions',
    'opportunities',
    'triggers',
    'trigger_bin_values',
    'trigger_restrictions',
    'audit_rules',
    'data_quality_issues',
    'scan_logs',
  ];

  let sql = '-- TheRxOS Staging Data Export\n';
  sql += `-- Generated: ${new Date().toISOString()}\n\n`;

  // Disable triggers during import
  sql += 'SET session_replication_role = replica;\n\n';

  for (const table of tables) {
    try {
      // Check if table exists
      const exists = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_name = $1
        )
      `, [table]);

      if (!exists.rows[0].exists) {
        console.log(`  Skipping ${table} (doesn't exist)`);
        continue;
      }

      // Get row count
      const countResult = await pool.query(`SELECT COUNT(*) as cnt FROM ${table}`);
      const count = parseInt(countResult.rows[0].cnt);
      console.log(`  Exporting ${table}: ${count} rows`);

      if (count === 0) continue;

      // Get all data
      const data = await pool.query(`SELECT * FROM ${table}`);

      // Get column names
      const columns = Object.keys(data.rows[0]);

      sql += `-- ${table}\n`;
      sql += `TRUNCATE ${table} CASCADE;\n`;

      for (const row of data.rows) {
        const values = columns.map(col => {
          const val = row[col];
          if (val === null) return 'NULL';
          if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
          if (typeof val === 'number') return val;
          if (val instanceof Date) return `'${val.toISOString()}'`;
          if (Array.isArray(val)) return `ARRAY[${val.map(v => `'${String(v).replace(/'/g, "''")}'`).join(',')}]`;
          if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
          return `'${String(val).replace(/'/g, "''")}'`;
        });
        sql += `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
      }
      sql += '\n';

    } catch (error) {
      console.log(`  Error exporting ${table}: ${error.message}`);
    }
  }

  // Re-enable triggers
  sql += 'SET session_replication_role = DEFAULT;\n';

  // Write to file
  fs.writeFileSync('staging-export.sql', sql);
  console.log(`\nExport complete: staging-export.sql (${(sql.length / 1024 / 1024).toFixed(2)} MB)`);

  await pool.end();
}

exportData().catch(console.error);
