// Drug class equivalency/dosing reference tables
// Used in opportunity sidebar to help staff identify correct strength recommendations

const EQUIVALENCY_TABLES = {
  statins: {
    className: 'Statins (HMG-CoA Reductase Inhibitors)',
    columns: ['Drug', 'Low-Intensity (<30%)', 'Moderate-Intensity (30-50%)', 'High-Intensity (\u226550%)'],
    rows: [
      { drug: 'Atorvastatin', values: ['\u2014', '10-20 mg', '40-80 mg'] },
      { drug: 'Fluvastatin', values: ['20-40 mg', '40 mg 2x/day; XL 80 mg', '\u2014'] },
      { drug: 'Lovastatin', values: ['20 mg', '40-80 mg', '\u2014'] },
      { drug: 'Pitavastatin', values: ['\u2014', '1-4 mg', '\u2014'] },
      { drug: 'Pravastatin', values: ['10-20 mg', '40-80 mg', '\u2014'] },
      { drug: 'Rosuvastatin', values: ['\u2014', '5-10 mg', '20-40 mg'] },
      { drug: 'Simvastatin', values: ['10 mg', '20-40 mg', '\u2014'] },
    ],
    note: 'Source: 2018 ACC/AHA Cholesterol Guidelines. LDL-C reduction percentages are approximate.'
  },
  arbs: {
    className: 'ARBs (Angiotensin Receptor Blockers)',
    columns: ['Drug', 'Low', 'Mid', 'High/Max'],
    rows: [
      { drug: 'Losartan', values: ['25 mg', '50 mg', '100 mg'] },
      { drug: 'Valsartan', values: ['40 mg', '80-160 mg', '320 mg'] },
      { drug: 'Irbesartan', values: ['75 mg', '150 mg', '300 mg'] },
      { drug: 'Candesartan', values: ['4 mg', '8-16 mg', '32 mg'] },
      { drug: 'Telmisartan', values: ['20 mg', '40 mg', '80 mg'] },
      { drug: 'Olmesartan', values: ['5-10 mg', '20 mg', '40 mg'] },
      { drug: 'Azilsartan', values: ['20 mg', '40 mg', '80 mg'] },
    ],
    note: 'Dosing ranges for hypertension management.'
  }
};

// Drug name -> class detection (mirrors scanner.js DRUG_PATTERNS)
const DRUG_CLASS_PATTERNS = {
  statins: /atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin|fluvastatin|pitavastatin|lipitor|crestor|zocor|pravachol|mevacor|lescol|livalo/i,
  ace_inhibitors: /lisinopril|enalapril|ramipril|benazepril|captopril|fosinopril|quinapril|moexipril|perindopril|trandolapril|prinivil|zestril|vasotec|altace/i,
  arbs: /losartan|valsartan|irbesartan|olmesartan|candesartan|telmisartan|azilsartan|cozaar|diovan|avapro/i,
  ppi: /omeprazole|esomeprazole|lansoprazole|pantoprazole|rabeprazole|dexlansoprazole|prilosec|nexium|prevacid|protonix|aciphex|dexilant/i,
  ssri: /fluoxetine|sertraline|paroxetine|escitalopram|citalopram|fluvoxamine|prozac|zoloft|paxil|lexapro|celexa/i,
  snri: /venlafaxine|duloxetine|desvenlafaxine|levomilnacipran|effexor|cymbalta|pristiq|fetzima/i,
  beta_blockers: /metoprolol|atenolol|carvedilol|bisoprolol|propranolol|nadolol|nebivolol|labetalol|lopressor|toprol|coreg/i,
  ccb: /amlodipine|nifedipine|diltiazem|verapamil|felodipine|nicardipine|norvasc|cardizem|procardia/i,
  sglt2: /canagliflozin|dapagliflozin|empagliflozin|ertugliflozin|invokana|farxiga|jardiance|steglatro/i,
  dpp4: /sitagliptin|saxagliptin|linagliptin|alogliptin|januvia|onglyza|tradjenta|nesina/i,
  glp1: /semaglutide|liraglutide|dulaglutide|exenatide|ozempic|wegovy|victoza|trulicity|byetta|bydureon/i,
  nsaids: /ibuprofen|naproxen|meloxicam|diclofenac|celecoxib|indomethacin|ketorolac|motrin|advil|aleve|mobic|voltaren|celebrex/i,
  anticoagulants: /warfarin|apixaban|rivaroxaban|dabigatran|edoxaban|coumadin|eliquis|xarelto|pradaxa|savaysa/i,
};

/**
 * Detect drug class from a drug name string
 */
function detectDrugClass(drugName) {
  if (!drugName) return null;
  const name = drugName.toLowerCase();
  for (const [cls, pattern] of Object.entries(DRUG_CLASS_PATTERNS)) {
    if (pattern.test(name)) return cls;
  }
  return null;
}

/**
 * Get equivalency table for a drug name
 * Returns { table, drugClass, matchedDrug } or { table: null }
 */
export function getEquivalencyForDrug(drugName) {
  const drugClass = detectDrugClass(drugName);
  if (!drugClass || !EQUIVALENCY_TABLES[drugClass]) {
    return { table: null, drugClass: null };
  }

  const table = EQUIVALENCY_TABLES[drugClass];

  // Find which row matches the drug name
  const nameLower = (drugName || '').toLowerCase();
  const matchedRow = table.rows.findIndex(r =>
    nameLower.includes(r.drug.toLowerCase())
  );

  return {
    table,
    drugClass,
    matchedRow: matchedRow >= 0 ? matchedRow : null
  };
}

export default EQUIVALENCY_TABLES;
