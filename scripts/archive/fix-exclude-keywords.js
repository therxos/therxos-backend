import 'dotenv/config';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  return (await res.json()).token;
}

async function getTriggers(baseUrl, token) {
  const res = await fetch(`${baseUrl}/api/admin/triggers`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return Array.isArray(data) ? data : (data.triggers || data.data || []);
}

async function updateTrigger(baseUrl, token, id, updates) {
  const res = await fetch(`${baseUrl}/api/admin/triggers/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  return res.json();
}

// Check if exclude_keywords would exclude the recommended drug search
function wouldSelfExclude(recommendedDrug, excludeKeywords) {
  if (!recommendedDrug || !excludeKeywords || excludeKeywords.length === 0) return false;

  const SKIP_WORDS = ['mg', 'mcg', 'ml', 'tab', 'cap', 'sol', 'cream', 'gel', 'oint', 'susp', 'inj', 'er', 'hcl', 'dr', 'sr', 'xr'];
  const searchWords = recommendedDrug
    .split(/[\s,.\-\(\)\[\]]+/)
    .map(w => w.trim().toUpperCase())
    .filter(w => w.length >= 2 && !SKIP_WORDS.includes(w.toLowerCase()) && !/^\d+$/.test(w));

  for (const ekw of excludeKeywords) {
    const excludeWords = ekw.split(/[\s,.\-\(\)\[\]]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length >= 2);

    // If ALL exclude words appear in the search words, it self-excludes
    if (excludeWords.length > 0 && excludeWords.every(ew =>
      searchWords.some(sw => sw === ew || sw.includes(ew) || ew.includes(sw))
    )) {
      return ekw;
    }
  }
  return false;
}

async function main() {
  const token = await login(PROD_URL);
  const triggers = await getTriggers(PROD_URL, token);

  console.log(`Checking ${triggers.length} triggers for self-excluding keywords...\n`);

  let fixed = 0;
  for (const t of triggers) {
    const excludeKw = t.exclude_keywords || [];
    if (excludeKw.length === 0) continue;

    const selfExcluding = wouldSelfExclude(t.recommended_drug, excludeKw);
    if (selfExcluding) {
      // Remove the self-excluding keyword(s)
      const newExcludes = excludeKw.filter(ekw => {
        const excludeWords = ekw.split(/[\s,.\-\(\)\[\]]+/)
          .map(w => w.trim().toUpperCase())
          .filter(w => w.length >= 2);
        const SKIP_WORDS = ['mg', 'mcg', 'ml', 'tab', 'cap', 'sol', 'cream', 'gel', 'oint', 'susp', 'inj', 'er', 'hcl', 'dr', 'sr', 'xr'];
        const searchWords = (t.recommended_drug || '')
          .split(/[\s,.\-\(\)\[\]]+/)
          .map(w => w.trim().toUpperCase())
          .filter(w => w.length >= 2 && !SKIP_WORDS.includes(w.toLowerCase()) && !/^\d+$/.test(w));

        return !excludeWords.every(ew =>
          searchWords.some(sw => sw === ew || sw.includes(ew) || ew.includes(sw))
        );
      });

      console.log(`FIX: ${t.display_name}`);
      console.log(`  recommended_drug: "${t.recommended_drug}"`);
      console.log(`  OLD exclude_keywords: ${JSON.stringify(excludeKw)}`);
      console.log(`  NEW exclude_keywords: ${JSON.stringify(newExcludes)}`);

      const result = await updateTrigger(PROD_URL, token, t.trigger_id, {
        excludeKeywords: newExcludes
      });

      if (result.trigger || result.success) {
        console.log(`  ✓ Updated`);
        fixed++;
      } else {
        console.log(`  ✗ FAILED: ${result.error}`);
      }
      console.log('');
    }
  }

  console.log(`\nFixed ${fixed} triggers with self-excluding keywords`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
