import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fixBinExclusions() {
  try {
    // First, see what has bin_restrictions
    const check = await pool.query(`
      SELECT trigger_id, display_name, trigger_code, bin_restrictions
      FROM triggers
      WHERE bin_restrictions IS NOT NULL
      ORDER BY display_name
    `);

    console.log('Triggers with BIN restrictions:');
    check.rows.forEach(r => {
      console.log(`- ${r.display_name} (${r.trigger_code})`);
    });
    console.log(`\nTotal: ${check.rows.length} triggers with restrictions\n`);

    // Clear bin_restrictions from all triggers EXCEPT GNP Pen Needles and Droplet Pen Needles
    const result = await pool.query(`
      UPDATE triggers
      SET bin_restrictions = NULL
      WHERE bin_restrictions IS NOT NULL
        AND LOWER(display_name) NOT LIKE '%gnp pen needle%'
        AND LOWER(display_name) NOT LIKE '%droplet pen needle%'
      RETURNING trigger_id, display_name
    `);

    console.log(`Cleared BIN restrictions from ${result.rowCount} triggers:`);
    result.rows.forEach(r => {
      console.log(`  - ${r.display_name}`);
    });

    // Show what remains
    const remaining = await pool.query(`
      SELECT display_name, bin_restrictions
      FROM triggers
      WHERE bin_restrictions IS NOT NULL
    `);
    console.log(`\nTriggers that still have BIN restrictions:`);
    remaining.rows.forEach(r => {
      console.log(`  - ${r.display_name}: ${JSON.stringify(r.bin_restrictions)}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

fixBinExclusions();
