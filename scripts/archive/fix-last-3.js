import 'dotenv/config';
import db from './src/database/index.js';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  return (await res.json()).token;
}

async function updateTrigger(token, id, updates) {
  const res = await fetch(`${PROD_URL}/api/admin/triggers/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  return res.json();
}

async function main() {
  const token = await login(PROD_URL);

  // Check what Comfort EZ syringe products exist
  console.log('=== Comfort EZ products in data ===');
  const r1 = await db.query(`
    SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
    FROM prescriptions
    WHERE POSITION('COMFORT' IN UPPER(drug_name)) > 0 AND POSITION('EZ' IN UPPER(drug_name)) > 0
    GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 20
  `);
  r1.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

  // Check Pure Comfort lancet products (singular vs plural)
  console.log('\n=== Pure Comfort lancet products ===');
  const r2 = await db.query(`
    SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
    FROM prescriptions
    WHERE POSITION('PURE' IN UPPER(drug_name)) > 0 AND POSITION('COMFORT' IN UPPER(drug_name)) > 0
      AND POSITION('LANCET' IN UPPER(drug_name)) > 0
    GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 20
  `);
  r2.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

  // Also check all syringe products with Comfort
  console.log('\n=== All syringe products ===');
  const r3 = await db.query(`
    SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
    FROM prescriptions
    WHERE (POSITION('COMFORT' IN UPPER(drug_name)) > 0 OR POSITION('EASY' IN UPPER(drug_name)) > 0)
      AND (POSITION('SYRINGE' IN UPPER(drug_name)) > 0 OR POSITION('SYR' IN UPPER(drug_name)) > 0)
    GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 20
  `);
  r3.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

  // Check: what does "COMFORT EZ" match broadly?
  console.log('\n=== All Comfort EZ products (no filter) ===');
  const r4 = await db.query(`
    SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
    FROM prescriptions
    WHERE POSITION('COMFORT EZ' IN UPPER(drug_name)) > 0
    GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 20
  `);
  r4.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

  // Now fix based on what we find
  console.log('\n=== APPLYING FIXES ===');

  // Fix Pure Comfort Lancets: use "Lancet" singular (not "Lancets")
  const t1 = await db.query("SELECT * FROM triggers WHERE display_name = 'Pure Comfort Lancets 30g ' AND is_enabled = true");
  if (t1.rows.length > 0) {
    // Check if "Pure Comfort Lancet" (singular) works
    const check = await db.query(`
      SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
      FROM prescriptions
      WHERE POSITION('PURE' IN UPPER(drug_name)) > 0
        AND POSITION('COMFORT' IN UPPER(drug_name)) > 0
        AND POSITION('LANCET' IN UPPER(drug_name)) > 0
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
      GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 10
    `);
    console.log(`Pure Comfort Lancet (singular) matches:`);
    check.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

    const result = await updateTrigger(token, t1.rows[0].trigger_id, {
      recommendedDrug: 'Pure Comfort Lancet'  // singular
    });
    console.log(result.trigger ? '✓ Updated Pure Comfort Lancets → "Pure Comfort Lancet"' : `✗ FAILED: ${result.error}`);
  }

  // Fix Comfort Ez Syringes based on what we find
  const t2 = await db.query("SELECT * FROM triggers WHERE display_name = 'Comfort Ez Syringes' AND is_enabled = true");
  if (t2.rows.length > 0) {
    // If Comfort EZ syringes exist as "COMFORT EZ" + something
    if (r4.rows.length > 0) {
      // Filter to just syringe-like products
      const syringeProducts = r4.rows.filter(d =>
        d.dn.includes('SYR') || d.dn.includes('INSULIN') || d.dn.includes('ML ')
      );
      if (syringeProducts.length > 0) {
        console.log(`\nComfort EZ syringe products found:`);
        syringeProducts.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));
      }
    }

    // Try just "Comfort EZ" which already works for pen needles
    // But "Comfort EZ" also matches pen needles. Since this trigger is for SYRINGES specifically,
    // we need to find what syringe products exist.
    // If no Comfort EZ syringes in data, try just "EZ Syringe" or broader syringe search
    const r5 = await db.query(`
      SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
      FROM prescriptions
      WHERE POSITION('COMFORT' IN UPPER(drug_name)) > 0
        AND (POSITION('SYR' IN UPPER(drug_name)) > 0 OR POSITION('INSUL' IN UPPER(drug_name)) > 0)
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
      GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 10
    `);
    console.log(`\nComfort + SYR/INSUL products:`);
    r5.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

    // Also check "Easy Comfort" brand syringes (common insulin syringe brand)
    const r6 = await db.query(`
      SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
      FROM prescriptions
      WHERE POSITION('EASY COMFORT' IN UPPER(drug_name)) > 0
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
      GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 10
    `);
    console.log(`\nEasy Comfort products:`);
    r6.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

    // Try "INSULIN SYRINGE" broadly
    const r7 = await db.query(`
      SELECT DISTINCT UPPER(drug_name) as dn, COUNT(*) as cnt
      FROM prescriptions
      WHERE POSITION('INSULIN' IN UPPER(drug_name)) > 0
        AND POSITION('SYRINGE' IN UPPER(drug_name)) > 0
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
      GROUP BY UPPER(drug_name) ORDER BY cnt DESC LIMIT 10
    `);
    console.log(`\nInsulin Syringe products:`);
    r7.rows.forEach(d => console.log(`  ${d.dn} (${d.cnt} claims)`));

    // Based on findings, set the best recommended_drug
    // For now, let's try "Comfort EZ" without "Syringe" if syringes aren't labeled that way
    if (r5.rows.length > 0) {
      // Found Comfort syringes
      const bestMatch = r5.rows[0].dn;
      // Use the first significant word after "COMFORT"
      const newRec = 'Comfort Syringe';
      const result = await updateTrigger(token, t2.rows[0].trigger_id, { recommendedDrug: newRec });
      console.log(result.trigger ? `✓ Updated Comfort Ez Syringes → "${newRec}"` : `✗ FAILED: ${result.error}`);
    } else if (r6.rows.length > 0) {
      // Use Easy Comfort brand
      const newRec = 'Easy Comfort';
      const result = await updateTrigger(token, t2.rows[0].trigger_id, { recommendedDrug: newRec });
      console.log(result.trigger ? `✓ Updated Comfort Ez Syringes → "${newRec}"` : `✗ FAILED: ${result.error}`);
    } else {
      console.log('⚠ No comfort/EZ syringe products found in data');
    }
  }

  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
