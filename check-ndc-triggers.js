import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function check() {
  // Find triggers related to pen needles and lancets
  const triggers = await pool.query(`
    SELECT trigger_code, display_name, recommended_drug, trigger_type, detection_keywords
    FROM triggers
    WHERE LOWER(display_name) LIKE '%pen needle%'
       OR LOWER(display_name) LIKE '%lancet%'
       OR LOWER(recommended_drug) LIKE '%droplet%'
       OR LOWER(recommended_drug) LIKE '%verifine%'
       OR LOWER(recommended_drug) LIKE '%gnp%'
       OR LOWER(recommended_drug) LIKE '%comfort%'
       OR LOWER(recommended_drug) LIKE '%pure comfort%'
    ORDER BY display_name
  `);

  console.log('Related triggers found:', triggers.rows.length);
  triggers.rows.forEach(t => {
    console.log('---');
    console.log('Code:', t.trigger_code);
    console.log('Display:', t.display_name);
    console.log('Recommended:', t.recommended_drug);
    console.log('Type:', t.trigger_type);
    console.log('Keywords:', t.detection_keywords);
  });

  await pool.end();
}

check().catch(console.error);
