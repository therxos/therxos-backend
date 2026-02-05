import 'dotenv/config';
import pg from 'pg';
import fs from 'fs';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function enrichFormulary() {
  console.log('Enriching drug formulary with CMS data...\n');

  // Load existing formulary
  const formulary = JSON.parse(fs.readFileSync('./data/drug-formulary.json', 'utf8'));

  // Get all drug patterns from formulary
  const allPatterns = [];
  for (const drugClass of formulary.drug_classes) {
    for (const drug of drugClass.drugs) {
      allPatterns.push(drug.generic_name.toLowerCase());
    }
  }

  console.log(`Looking up CMS data for ${allPatterns.length} drugs...`);

  // Get aggregated CMS stats by drug name pattern in one query
  const cmsStats = await pool.query(`
    WITH drug_matches AS (
      SELECT
        p.drug_name,
        p.ndc,
        cfd.tier_level,
        cfd.prior_authorization_yn as pa,
        cfd.step_therapy_yn as st,
        cfd.quantity_limit_yn as ql,
        cfd.quantity_limit_amount,
        cfd.quantity_limit_days
      FROM prescriptions p
      JOIN cms_formulary_drugs cfd ON p.ndc = cfd.ndc
      WHERE p.ndc IS NOT NULL
    )
    SELECT
      LOWER(SPLIT_PART(drug_name, ' ', 1)) as drug_key,
      COUNT(DISTINCT ndc) as ndc_count,
      AVG(tier_level) as avg_tier,
      SUM(CASE WHEN pa THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as pa_rate,
      SUM(CASE WHEN st THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as st_rate,
      SUM(CASE WHEN ql THEN 1 ELSE 0 END)::float / COUNT(*) * 100 as ql_rate,
      MODE() WITHIN GROUP (ORDER BY quantity_limit_amount) as common_ql_amount,
      MODE() WITHIN GROUP (ORDER BY quantity_limit_days) as common_ql_days
    FROM drug_matches
    GROUP BY LOWER(SPLIT_PART(drug_name, ' ', 1))
  `);

  // Build lookup map
  const cmsLookup = new Map();
  for (const row of cmsStats.rows) {
    cmsLookup.set(row.drug_key, {
      ndc_count: parseInt(row.ndc_count),
      avg_tier: Math.round(parseFloat(row.avg_tier || 0) * 10) / 10,
      pa_rate: Math.round(parseFloat(row.pa_rate || 0)),
      st_rate: Math.round(parseFloat(row.st_rate || 0)),
      ql_rate: Math.round(parseFloat(row.ql_rate || 0)),
      common_ql: row.common_ql_amount ? `${row.common_ql_amount}/${row.common_ql_days}d` : null
    });
  }

  console.log(`Found CMS data for ${cmsLookup.size} drug keys\n`);

  // Enrich each drug class
  for (const drugClass of formulary.drug_classes) {
    console.log(`Processing: ${drugClass.class_name}`);

    let classHits = 0;
    for (const drug of drugClass.drugs) {
      const drugKey = drug.generic_name.toLowerCase().split(' ')[0];
      const cmsData = cmsLookup.get(drugKey);

      if (cmsData) {
        drug.cms_coverage = {
          ndc_count: cmsData.ndc_count,
          average_tier: cmsData.avg_tier,
          prior_auth_rate: cmsData.pa_rate,
          step_therapy_rate: cmsData.st_rate,
          quantity_limit_rate: cmsData.ql_rate,
          common_quantity_limit: cmsData.common_ql
        };
        classHits++;
        console.log(`  ✓ ${drug.generic_name}: Tier ${cmsData.avg_tier}, PA ${cmsData.pa_rate}%, QL ${cmsData.ql_rate}%`);
      } else {
        drug.cms_coverage = null;
        console.log(`  - ${drug.generic_name}: No data`);
      }
    }

    // Class summary
    const drugsWithCoverage = drugClass.drugs.filter(d => d.cms_coverage);
    if (drugsWithCoverage.length > 0) {
      drugClass.cms_summary = {
        drugs_with_data: drugsWithCoverage.length,
        avg_prior_auth_rate: Math.round(drugsWithCoverage.reduce((sum, d) => sum + d.cms_coverage.prior_auth_rate, 0) / drugsWithCoverage.length),
        avg_step_therapy_rate: Math.round(drugsWithCoverage.reduce((sum, d) => sum + d.cms_coverage.step_therapy_rate, 0) / drugsWithCoverage.length),
        avg_quantity_limit_rate: Math.round(drugsWithCoverage.reduce((sum, d) => sum + d.cms_coverage.quantity_limit_rate, 0) / drugsWithCoverage.length),
        avg_tier: Math.round(drugsWithCoverage.reduce((sum, d) => sum + d.cms_coverage.average_tier, 0) / drugsWithCoverage.length * 10) / 10
      };
    }
  }

  // Update metadata
  formulary.cms_data_enriched = true;
  formulary.cms_enrichment_date = new Date().toISOString();

  // Save enriched formulary
  fs.writeFileSync('./data/drug-formulary.json', JSON.stringify(formulary, null, 2));
  console.log('\n✅ Enriched formulary saved to data/drug-formulary.json');

  await pool.end();
}

enrichFormulary().catch(console.error);
