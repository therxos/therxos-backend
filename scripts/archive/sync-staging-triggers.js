import 'dotenv/config';

const PROD_URL = 'https://therxos-backend-production.up.railway.app';
const STAGING_URL = 'https://discerning-mindfulness-production-07d5.up.railway.app';

async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'stan@therxos.com', password: 'demo1234' })
  });
  const data = await res.json();
  return data.token;
}

async function getTriggers(baseUrl, token) {
  const res = await fetch(`${baseUrl}/api/admin/triggers`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  return Array.isArray(data) ? data : (data.triggers || data.data || []);
}

async function deleteTrigger(baseUrl, token, triggerId, name) {
  const res = await fetch(`${baseUrl}/api/admin/triggers/${triggerId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (data.success) {
    console.log(`  DELETED: ${name}`);
  } else {
    console.log(`  FAILED to delete ${name}: ${data.error || JSON.stringify(data)}`);
  }
}

async function createTrigger(baseUrl, token, t) {
  const body = {
    triggerCode: t.trigger_code || null,
    displayName: t.display_name,
    triggerType: t.trigger_type,
    category: t.category || null,
    detectionKeywords: t.detection_keywords || [],
    excludeKeywords: t.exclude_keywords || [],
    ifHasKeywords: t.if_has_keywords || [],
    ifNotHasKeywords: t.if_not_has_keywords || [],
    recommendedDrug: t.recommended_drug || null,
    recommendedNdc: t.recommended_ndc || null,
    actionInstructions: t.action_instructions || null,
    clinicalRationale: t.clinical_rationale || t.rationale || null,
    priority: t.priority || 'medium',
    annualFills: t.annual_fills || 12,
    defaultGpValue: t.default_gp_value || null,
    isEnabled: t.is_enabled,
    keywordMatchMode: t.keyword_match_mode || 'any',
    pharmacyInclusions: t.pharmacy_inclusions || [],
    expectedQty: t.expected_qty || null,
    expectedDaysSupply: t.expected_days_supply || null,
    binInclusions: t.bin_inclusions || null,
    binExclusions: t.bin_exclusions || null,
    groupInclusions: t.group_inclusions || null,
    groupExclusions: t.group_exclusions || null,
    contractPrefixExclusions: t.contract_prefix_exclusions || null,
    triggerGroup: t.trigger_group || null,
    minMarginDefault: t.min_margin_default || null,
  };
  const res = await fetch(`${baseUrl}/api/admin/triggers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    if (data.trigger || data.success) {
      console.log(`  CREATED: ${t.display_name}`);
      return true;
    } else {
      console.log(`  FAILED to create ${t.display_name}: ${data.error || text.substring(0, 200)}`);
      return false;
    }
  } catch (e) {
    console.log(`  FAILED to create ${t.display_name}: ${text.substring(0, 200)}`);
    return false;
  }
}

async function updateTrigger(baseUrl, token, triggerId, t) {
  const body = {
    displayName: t.display_name,
    recommendedDrug: t.recommended_drug,
    recommendedNdc: t.recommended_ndc,
    triggerType: t.trigger_type,
    triggerGroup: t.trigger_group,
    category: t.category,
    detectionKeywords: t.detection_keywords || [],
    excludeKeywords: t.exclude_keywords || [],
    ifHasKeywords: t.if_has_keywords || [],
    ifNotHasKeywords: t.if_not_has_keywords || [],
    isEnabled: t.is_enabled,
    minMarginDefault: t.min_margin_default,
    annualFills: t.annual_fills,
    defaultGpValue: t.default_gp_value,
    clinicalRationale: t.clinical_rationale || t.rationale,
    actionInstructions: t.action_instructions,
    expectedQty: t.expected_qty,
    expectedDaysSupply: t.expected_days_supply,
    pharmacyInclusions: t.pharmacy_inclusions || [],
    keywordMatchMode: t.keyword_match_mode || 'any',
    priority: t.priority,
    binInclusions: t.bin_inclusions,
    binExclusions: t.bin_exclusions,
    groupInclusions: t.group_inclusions,
    groupExclusions: t.group_exclusions,
    contractPrefixExclusions: t.contract_prefix_exclusions,
  };
  const res = await fetch(`${baseUrl}/api/admin/triggers/${triggerId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data;
}

async function main() {
  console.log('Logging in...');
  const prodToken = await login(PROD_URL);
  const stagingToken = await login(STAGING_URL);

  console.log('Fetching triggers...');
  const prodTriggers = await getTriggers(PROD_URL, prodToken);
  const stagingTriggers = await getTriggers(STAGING_URL, stagingToken);

  console.log(`Production: ${prodTriggers.length} triggers`);
  console.log(`Staging: ${stagingTriggers.length} triggers`);

  const prodByName = new Map(prodTriggers.map(t => [t.display_name, t]));
  const stagingByName = new Map(stagingTriggers.map(t => [t.display_name, t]));

  // Delete staging triggers not in production
  console.log('\n--- Deleting extra staging triggers ---');
  let deleted = 0;
  for (const [name, trigger] of stagingByName) {
    if (!prodByName.has(name)) {
      await deleteTrigger(STAGING_URL, stagingToken, trigger.trigger_id, name);
      deleted++;
    }
  }
  console.log(`Deleted ${deleted} triggers`);

  // Create/update to match production
  console.log('\n--- Syncing triggers ---');
  let created = 0, updated = 0;
  for (const [name, prodTrigger] of prodByName) {
    const stagingTrigger = stagingByName.get(name);
    if (stagingTrigger) {
      // Update to match production
      const result = await updateTrigger(STAGING_URL, stagingToken, stagingTrigger.trigger_id, prodTrigger);
      if (result.trigger || result.success) {
        console.log(`  UPDATED: ${name}`);
        updated++;
      } else {
        console.log(`  FAILED update ${name}: ${result.error}`);
      }
    } else {
      // Create on staging
      if (await createTrigger(STAGING_URL, stagingToken, prodTrigger)) {
        created++;
      }
    }
  }

  console.log(`\nCreated: ${created}, Updated: ${updated}, Deleted: ${deleted}`);

  // Verify final count
  const final = await getTriggers(STAGING_URL, stagingToken);
  console.log(`Final staging: ${final.length} triggers (production: ${prodTriggers.length})`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
