import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // 1. Check recommended_ndc on opportunities
  console.log('=== RECOMMENDED NDC STATUS ===');
  const ndcStats = await pool.query(`
    SELECT
      COUNT(*) as total_opps,
      COUNT(recommended_ndc) as has_ndc,
      COUNT(*) - COUNT(recommended_ndc) as missing_ndc
    FROM opportunities
  `);
  console.log(ndcStats.rows[0]);

  // 2. Check trigger_bin_values best_ndc
  const bestNdc = await pool.query(`
    SELECT COUNT(*) as total, COUNT(best_ndc) as has_best_ndc
    FROM trigger_bin_values
  `);
  console.log('\n=== TRIGGER_BIN_VALUES ===');
  console.log(bestNdc.rows[0]);

  // 3. Check triggers that have recommended_ndc set
  const triggersWithNdc = await pool.query(`
    SELECT trigger_id, display_name, recommended_ndc, recommended_drug
    FROM triggers WHERE recommended_ndc IS NOT NULL
  `);
  console.log(`\nTriggers with recommended_ndc: ${triggersWithNdc.rows.length}`);
  for (const t of triggersWithNdc.rows) {
    console.log(`  ${t.display_name}: NDC=${t.recommended_ndc}`);
  }

  // 4. Check Comfort EZ / pen needles trigger
  console.log('\n=== COMFORT EZ / PEN NEEDLES TRIGGER ===');
  const comfortTrigger = await pool.query(`
    SELECT trigger_id, display_name, detection_keywords, exclude_keywords,
           recommended_drug, trigger_type, category, default_gp_value, annual_fills
    FROM triggers
    WHERE UPPER(display_name) LIKE '%COMFORT%'
       OR UPPER(display_name) LIKE '%PEN NEEDLE%'
       OR UPPER(display_name) LIKE '%NEEDLE%'
  `);
  for (const t of comfortTrigger.rows) {
    console.log(JSON.stringify(t, null, 2));

    // Check bin_values for this trigger
    const bv = await pool.query(`
      SELECT COUNT(*) as bin_count FROM trigger_bin_values WHERE trigger_id = $1
    `, [t.trigger_id]);
    console.log(`  bin_values count: ${bv.rows[0].bin_count}`);

    // Check opportunities for this trigger
    const opps = await pool.query(`
      SELECT status, COUNT(*) as cnt FROM opportunities WHERE trigger_id = $1 GROUP BY status ORDER BY cnt DESC
    `, [t.trigger_id]);
    console.log('  opportunities by status:', opps.rows);
  }

  // 5. ALL triggers with bin_values counts
  console.log('\n=== ALL TRIGGERS WITH BIN_VALUES ===');
  const allTriggers = await pool.query(`
    SELECT t.trigger_id, t.display_name,
      COALESCE(bv.bin_count, 0) as bin_values_count,
      COALESCE(o.opp_count, 0) as opp_count
    FROM triggers t
    LEFT JOIN (SELECT trigger_id, COUNT(*) as bin_count FROM trigger_bin_values GROUP BY trigger_id) bv ON bv.trigger_id = t.trigger_id
    LEFT JOIN (SELECT trigger_id, COUNT(*) as opp_count FROM opportunities WHERE status = 'Not Submitted' GROUP BY trigger_id) o ON o.trigger_id = t.trigger_id
    ORDER BY t.display_name
  `);
  console.log('Trigger                                  | BIN Values | Not Submitted Opps');
  console.log('-'.repeat(80));
  for (const t of allTriggers.rows) {
    console.log(`${t.display_name.substring(0,40).padEnd(40)} | ${String(t.bin_values_count).padStart(10)} | ${String(t.opp_count).padStart(6)}`);
  }

  // 6. Check if the scanner.js is setting recommended_ndc
  console.log('\n=== SCANNER NDC ISSUE ===');
  console.log('scanner.js candidateOpps push does NOT include recommended_ndc');
  console.log('admin.js scanner DOES include recommended_ndc (trigger.recommended_ndc)');
  console.log('But neither uses the BIN-specific best_ndc from trigger_bin_values');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
