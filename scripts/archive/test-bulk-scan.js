import 'dotenv/config';
import db from './src/database/index.js';

async function main() {
  const t = await db.query('SELECT * FROM triggers WHERE is_enabled = true LIMIT 1');
  const trigger = t.rows[0];
  console.log('Testing with trigger:', trigger.display_name);

  const keywords = trigger.detection_keywords || [];
  if (keywords.length === 0) { console.log('No keywords'); process.exit(0); }

  const ph = await db.query(`SELECT p.pharmacy_id FROM pharmacies p JOIN clients c ON c.client_id = p.client_id WHERE c.status != 'demo'`);
  const pharmacyIds = ph.rows.map(r => r.pharmacy_id);
  console.log('Pharmacies:', pharmacyIds.length);

  const keywordPatterns = keywords.map(k => `%${k.toLowerCase()}%`);
  const queryParams = [pharmacyIds, trigger.trigger_id, trigger.recommended_drug || ''];
  let paramIdx = 4;

  const keywordConditions = keywordPatterns.map(kp => {
    queryParams.push(kp);
    return `LOWER(pr.drug_name) LIKE $${paramIdx++}`;
  }).join(' OR ');

  const binExclusions = (trigger.bin_exclusions || []).map(b => String(b).trim());
  const groupExclusions = trigger.group_exclusions || [];
  const excludeKeywords = trigger.exclude_keywords || [];

  let exclusionSQL = '';
  if (binExclusions.length > 0) {
    queryParams.push(binExclusions);
    exclusionSQL += ` AND pr.insurance_bin != ALL($${paramIdx++})`;
  }
  if (groupExclusions.length > 0) {
    queryParams.push(groupExclusions);
    exclusionSQL += ` AND (pr.insurance_group IS NULL OR pr.insurance_group != ALL($${paramIdx++}))`;
  }

  let excludeSQL = '';
  if (excludeKeywords.length > 0) {
    const excConds = excludeKeywords.map(ek => {
      queryParams.push(ek.toUpperCase());
      return `POSITION($${paramIdx++} IN UPPER(pr.drug_name)) = 0`;
    });
    excludeSQL = ` AND (${excConds.join(' AND ')})`;
  }

  const triggerType = trigger.trigger_type || 'therapeutic_interchange';
  const triggerGroup = trigger.trigger_group || '';
  const recommendedDrug = trigger.recommended_drug || '';
  const recommendedNdc = trigger.recommended_ndc || '';
  const annualFills = trigger.annual_fills || 12;
  const defaultGp = trigger.default_gp_value || 0;
  const rationale = trigger.clinical_rationale || '';

  queryParams.push(triggerType, triggerGroup, recommendedDrug, recommendedNdc, annualFills, defaultGp, rationale);
  const triggerTypeIdx = paramIdx++;
  const triggerGroupIdx = paramIdx++;
  const recDrugIdx = paramIdx++;
  const recNdcIdx = paramIdx++;
  const annualFillsIdx = paramIdx++;
  const defaultGpIdx = paramIdx++;
  const rationaleIdx = paramIdx++;

  // Test with SELECT COUNT instead of INSERT first
  const sql = `
    WITH matching_patients AS (
      SELECT DISTINCT ON (p.patient_id)
        p.patient_id, p.pharmacy_id,
        pr.prescription_id, pr.drug_name as current_drug, pr.ndc as current_ndc,
        pr.prescriber_name, pr.quantity_dispensed,
        pr.insurance_bin, pr.insurance_group
      FROM patients p
      JOIN prescriptions pr ON pr.patient_id = p.patient_id
      WHERE p.pharmacy_id = ANY($1::uuid[])
        AND pr.dispensed_date >= NOW() - INTERVAL '90 days'
        AND (${keywordConditions})
        ${exclusionSQL}
        ${excludeSQL}
      ORDER BY p.patient_id, pr.dispensed_date DESC
    ),
    existing_opps AS (
      SELECT DISTINCT patient_id FROM opportunities
      WHERE (trigger_id = $2 OR UPPER(recommended_drug_name) = UPPER($3))
        AND status NOT IN ('Denied', 'Declined')
    ),
    new_patients AS (
      SELECT mp.*,
        COALESCE(tbv.gp_value, $${defaultGpIdx}::numeric) as gp_value,
        tbv.avg_qty,
        COALESCE(tbv.best_ndc, $${recNdcIdx}::text) as best_ndc
      FROM matching_patients mp
      LEFT JOIN existing_opps eo ON eo.patient_id = mp.patient_id
      LEFT JOIN LATERAL (
        SELECT gp_value, avg_qty, best_ndc
        FROM trigger_bin_values
        WHERE trigger_id = $2
          AND insurance_bin = mp.insurance_bin
          AND COALESCE(insurance_group, '') = COALESCE(mp.insurance_group, '')
          AND (is_excluded = false OR is_excluded IS NULL)
        LIMIT 1
      ) tbv ON true
      WHERE eo.patient_id IS NULL
    )
    SELECT COUNT(*) as cnt FROM new_patients`;

  console.log(`Running query with ${queryParams.length} params (indices up to $${paramIdx - 1})...`);
  try {
    const result = await db.query(sql, queryParams);
    console.log('Success! Would insert', result.rows[0].cnt, 'new opportunities');
  } catch (e) {
    console.error('SQL Error:', e.message);
    console.error('Detail:', e.detail || e.hint || 'none');
  }
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
