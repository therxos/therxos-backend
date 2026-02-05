import fs from 'fs';

// Check PRODUCTION
const prodLogin = await fetch('https://therxos-backend-production.up.railway.app/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
});
const prodToken = (await prodLogin.json()).token;

const res = await fetch('https://therxos-backend-production.up.railway.app/api/admin/triggers', {
  headers: { Authorization: 'Bearer ' + prodToken }
});
const data = await res.json();
for (const t of data.triggers) {
  if (t.display_name.toLowerCase().includes('diclofenac')) {
    console.log('=== PRODUCTION: ' + t.display_name + ' ===');
    console.log('recommended_drug:', JSON.stringify(t.recommended_drug));
    console.log('recommended_ndc:', t.recommended_ndc);
    console.log('detection_keywords:', JSON.stringify(t.detection_keywords));
    console.log('exclude_keywords:', JSON.stringify(t.exclude_keywords));
    console.log('default_gp:', t.default_gp_value);
    const bins = (t.bin_values || [])
      .filter(b => b.isExcluded !== true)
      .sort((a, b) => (b.gpValue || 0) - (a.gpValue || 0))
      .slice(0, 8);
    for (const bv of bins) {
      console.log('  ', bv.bin + '/' + (bv.group || ''), 'GP:', bv.gpValue, 'Qty:', bv.avgQty, '-', bv.bestDrugName);
    }
    console.log();
  }
}
