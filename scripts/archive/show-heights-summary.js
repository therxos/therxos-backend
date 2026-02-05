import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function showSummary() {
  // Total opportunities
  const total = await pool.query(
    'SELECT COUNT(*) as cnt, SUM(annual_margin_gain) as total FROM opportunities WHERE pharmacy_id = $1',
    [pharmacyId]
  );
  console.log('='.repeat(70));
  console.log('HEIGHTS CHEMIST OPPORTUNITY SUMMARY');
  console.log('='.repeat(70));
  console.log('Total Opportunities:', total.rows[0].cnt);
  console.log('Total Annual Potential: $' + Number(total.rows[0].total).toLocaleString());

  // By type
  console.log('\nBy Opportunity Type:');
  const byType = await pool.query(`
    SELECT opportunity_type, COUNT(*) as cnt, SUM(annual_margin_gain) as total
    FROM opportunities WHERE pharmacy_id = $1
    GROUP BY opportunity_type ORDER BY total DESC
  `, [pharmacyId]);
  for (const r of byType.rows) {
    console.log('  ' + r.opportunity_type.padEnd(25) + ': ' + String(r.cnt).padStart(5) + ' opps | $' + Number(r.total).toLocaleString());
  }

  // Top recommended drugs
  console.log('\nTop Recommended Drugs:');
  const topDrugs = await pool.query(`
    SELECT recommended_drug, COUNT(*) as cnt, SUM(annual_margin_gain) as total
    FROM opportunities WHERE pharmacy_id = $1 AND recommended_drug IS NOT NULL
    GROUP BY recommended_drug ORDER BY total DESC LIMIT 15
  `, [pharmacyId]);
  for (const r of topDrugs.rows) {
    console.log('  ' + (r.recommended_drug || '').substring(0, 35).padEnd(37) + ': ' + String(r.cnt).padStart(4) + ' | $' + Number(r.total).toLocaleString());
  }

  // Top current drugs being targeted
  console.log('\nTop Current Drugs with Opportunities:');
  const topCurrent = await pool.query(`
    SELECT current_drug_name, COUNT(*) as cnt, SUM(annual_margin_gain) as total
    FROM opportunities WHERE pharmacy_id = $1 AND current_drug_name IS NOT NULL
    GROUP BY current_drug_name ORDER BY total DESC LIMIT 20
  `, [pharmacyId]);
  for (const r of topCurrent.rows) {
    console.log('  ' + (r.current_drug_name || '').substring(0, 40).padEnd(42) + ': ' + String(r.cnt).padStart(4) + ' | $' + Number(r.total).toLocaleString());
  }

  await pool.end();
}

showSummary().catch(console.error);
