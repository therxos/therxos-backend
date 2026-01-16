import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

async function check() {
  // Check current opportunities
  const opps = await pool.query(
    'SELECT COUNT(*) as cnt, SUM(annual_margin_gain) as total_annual FROM opportunities WHERE pharmacy_id = $1',
    [pharmacyId]
  );
  console.log('Current Opportunities:', opps.rows[0].cnt, '| Total Annual: $' + Number(opps.rows[0].total_annual || 0).toLocaleString());

  // Top BINs by prescription count (gross_profit = insurance_pay - acquisition_cost)
  const bins = await pool.query(`
    SELECT insurance_bin, insurance_group, COUNT(*) as rx_count,
           SUM(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as total_gp,
           AVG(COALESCE(insurance_pay, 0) - COALESCE(acquisition_cost, 0)) as avg_gp
    FROM prescriptions
    WHERE pharmacy_id = $1 AND insurance_bin IS NOT NULL
    GROUP BY insurance_bin, insurance_group
    ORDER BY rx_count DESC
    LIMIT 20
  `, [pharmacyId]);

  console.log('\nTop BINs/Groups at Heights Chemist:');
  console.log('BIN       | GROUP           | Rx Count | Total GP     | Avg GP');
  console.log('-'.repeat(70));
  bins.rows.forEach(r => {
    console.log(
      (r.insurance_bin || '').padEnd(10),
      '|', (r.insurance_group || '(none)').padEnd(15),
      '|', String(r.rx_count).padStart(8),
      '|', ('$' + Number(r.total_gp || 0).toFixed(0)).padStart(12),
      '|', '$' + Number(r.avg_gp || 0).toFixed(2)
    );
  });

  // Check which enabled triggers exist
  const triggers = await pool.query(`
    SELECT trigger_id, trigger_type, display_name, default_gp_value,
      (SELECT COUNT(*) FROM trigger_bin_values WHERE trigger_id = t.trigger_id) as bin_configs
    FROM triggers t
    WHERE is_enabled = true
    ORDER BY trigger_type
  `);

  console.log('\n\nEnabled Triggers:');
  console.log('Type                 | Display Name                    | Default GP | BIN Configs');
  console.log('-'.repeat(85));
  triggers.rows.forEach(t => {
    console.log(
      (t.trigger_type || '').padEnd(20),
      '|', (t.display_name || '').substring(0, 30).padEnd(30),
      '|', ('$' + (t.default_gp_value || 50)).padStart(10),
      '|', String(t.bin_configs).padStart(6)
    );
  });

  await pool.end();
}

check().catch(console.error);
