import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function check() {
  const r = await pool.query(`
    SELECT trigger_id, display_name, annual_fills, default_gp_value, recommended_drug, recommended_ndc
    FROM triggers
    WHERE LOWER(display_name) LIKE '%restasis%'
       OR LOWER(display_name) LIKE '%cyclosporine%'
       OR LOWER(recommended_drug) LIKE '%cyclosporine%'
  `);
  console.log('Restasis/Cyclosporine triggers:');
  r.rows.forEach(t => console.log(`  ${t.display_name}: annual_fills=${t.annual_fills}, default_gp=$${t.default_gp_value}, rec_drug=${t.recommended_drug}`));

  // Check a sample opp
  const opps = await pool.query(`
    SELECT o.potential_margin_gain, o.annual_margin_gain, o.recommended_drug_name, o.avg_dispensed_qty,
           t.annual_fills, t.default_gp_value
    FROM opportunities o
    LEFT JOIN triggers t ON t.trigger_id = o.trigger_id
    WHERE LOWER(o.recommended_drug_name) LIKE '%cyclosporine%'
    LIMIT 5
  `);
  console.log('\nSample Cyclosporine opps:');
  opps.rows.forEach(o => console.log(`  GP=$${o.potential_margin_gain}, Annual=$${o.annual_margin_gain}, avg_qty=${o.avg_dispensed_qty}, trigger annual_fills=${o.annual_fills}, trigger default_gp=$${o.default_gp_value}`));

  process.exit(0);
}

check().catch(e => { console.error(e); process.exit(1); });
