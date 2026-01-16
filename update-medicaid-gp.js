import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MEDICAID_BIN = '004740';

// Manually verified GP values based on actual NY Medicaid claims
// These are the RECOMMENDED drug GPs, not the current drug
const VERIFIED_MEDICAID_GP = {
  // Verified with actual claims - use realistic Medicaid values
  'Diclofenac 2%': 20, // Medicaid pays ~$17-20 for diclofenac
  'cyclosporine 0.05%': 35, // Generic cyclosporine
  'Cyclosporine Emulsion 0.05%': 35,
  'mometasone spr': 33,
  'Cetirizine Chew': 11,
  'Lidocaine 5% ointment': 75, // This one actually pays well
  'Amlodipine-Atorvastat': 12,
  'sucralfate susp 1 gm/10ml': 100, // Suspension pays better
  'Potassium Liquid': 150, // Liquids pay better
  'Fluticasone-Salmetrol': 17,
  'Ondansetron': 13,
  'Test Strips': 130, // Test strips pay well on Medicaid
  'Lamotrigine ODT': 15, // ODT is low margin on Medicaid
  'Alcohol Pad': 2,
  'Lancet': 6,
  'Dorzolamide-Timolol PF (Cosopt PF)': 21,
  'Ezetimibe': 14,
  'Colchicine': 25,
  'Rizatriptan ODT': 14,
  // These we don't have data for - use conservative estimates
  'Pitavastatin': 50, // Conservative - no Medicaid claims
  'Saxagliptin': 40,
  'Blood Pressure Monitor': 30, // DME on Medicaid is low
  'Spacer': 25,
  'Omega': 15,
  'Ramelteon 8mg Tab': 20,
  'Comfort EZ Pen Needles': 5, // Pen needles are low margin
  'Risperidone ODT': 20,
  'Pure Comfort': 6,
  'Risedronate': 20,
  'Varenicline': 25,
  'Aripraprazole ODT': 20,
  'Dexlansoprazole': 25,
  'Levalbuterol': 20,
  'Glucagon': 50,
  'Travoprost': 25,
  'GNP Pen': 5,
  'Solifenacin': 15,
  'Droplet Pen Needles': 5,
  'Kloxxado': 40,
  'Ibandronate': 15,
};

async function updateMedicaidGP() {
  console.log('='.repeat(80));
  console.log('UPDATING BIN 004740 (NY MEDICAID) GP VALUES');
  console.log('='.repeat(80));

  // Get all triggers with BIN 004740 configured
  const triggers = await pool.query(`
    SELECT t.trigger_id, t.display_name, t.recommended_drug, t.default_gp_value,
           tbv.id as bin_value_id, tbv.gp_value as current_gp
    FROM triggers t
    JOIN trigger_bin_values tbv ON t.trigger_id = tbv.trigger_id
    WHERE tbv.insurance_bin = $1 AND t.is_enabled = true
  `, [MEDICAID_BIN]);

  console.log(`Found ${triggers.rows.length} triggers with BIN 004740 configured\n`);

  let updated = 0;
  let excluded = 0;

  for (const trigger of triggers.rows) {
    const recDrug = trigger.recommended_drug || '';

    // Find matching GP value
    let newGp = null;
    for (const [drug, gp] of Object.entries(VERIFIED_MEDICAID_GP)) {
      if (recDrug.toUpperCase().includes(drug.toUpperCase()) ||
          drug.toUpperCase().includes(recDrug.toUpperCase().split(' ')[0])) {
        newGp = gp;
        break;
      }
    }

    if (newGp === null) {
      // Default to a conservative $15 for unknown Medicaid items
      newGp = 15;
    }

    // If GP is too low (under $5), mark as excluded
    if (newGp < 5) {
      await pool.query(`
        UPDATE trigger_bin_values
        SET gp_value = $1, is_excluded = true
        WHERE id = $2
      `, [newGp, trigger.bin_value_id]);
      console.log(`❌ EXCLUDED: ${trigger.display_name.substring(0, 45).padEnd(47)} | Old: $${trigger.current_gp} → New: $${newGp} (too low)`);
      excluded++;
    } else {
      await pool.query(`
        UPDATE trigger_bin_values
        SET gp_value = $1, is_excluded = false
        WHERE id = $2
      `, [newGp, trigger.bin_value_id]);
      const diff = newGp - trigger.current_gp;
      const diffStr = diff >= 0 ? `+$${diff}` : `-$${Math.abs(diff)}`;
      console.log(`✓ Updated: ${trigger.display_name.substring(0, 45).padEnd(47)} | $${trigger.current_gp} → $${newGp} (${diffStr})`);
      updated++;
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`Updated: ${updated} triggers`);
  console.log(`Excluded (GP too low): ${excluded} triggers`);

  // Now recalculate opportunity values for Heights Chemist
  const pharmacyId = 'fa9cd714-c36a-46e9-9ed8-50ba5ada69d8';

  // This is complex - we'd need to know which opportunities came from 004740
  // For now, let's just show what the new totals would be
  console.log('\nNote: Existing opportunities need to be rescanned to reflect new GP values.');

  await pool.end();
}

updateMedicaidGP().catch(console.error);
