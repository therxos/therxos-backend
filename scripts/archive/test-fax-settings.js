import db from './src/database/index.js';

async function main() {
  const r = await db.query("SELECT pharmacy_id FROM pharmacies LIMIT 1");
  const id = r.rows[0].pharmacy_id;
  console.log('Testing with pharmacy:', id);

  try {
    const result = await db.query(`
      UPDATE pharmacies
      SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb,
          updated_at = NOW()
      WHERE pharmacy_id = $2
      RETURNING pharmacy_id, pharmacy_name, settings
    `, [JSON.stringify({ faxEnabled: true }), id]);
    console.log('Success:', result.rows[0]);
  } catch (e) {
    console.error('Query error:', e.message);
    console.error('Detail:', e.detail);
    console.error('Code:', e.code);
  }
  process.exit(0);
}
main();
