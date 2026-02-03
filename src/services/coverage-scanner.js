// Nightly coverage scanner service
// Scans all enabled triggers to find best-reimbursing products per BIN/Group
// Updates trigger_bin_values and backfills opportunity margins
//
// Used by:
// - POST /api/admin/triggers/verify-all-coverage (manual)
// - Nightly cron job (2 AM ET)

import db from '../database/index.js';
import { logger } from '../utils/logger.js';

const GP_SQL = `COALESCE(
  NULLIF(REPLACE(raw_data->>'gross_profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Gross Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'grossprofit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'GrossProfit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'net_profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Net Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'netprofit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'NetProfit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'adj_profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Adj Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'adjprofit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'AdjProfit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
  NULLIF(REPLACE(raw_data->>'adjusted_profit', ',', '')::numeric, 0),
  NULLIF(
    REPLACE(REPLACE(COALESCE(raw_data->>'Price','0'), '$', ''), ',', '')::numeric
    - REPLACE(REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', ''), ',', '')::numeric,
  0)
)`;

const DAYS_SUPPLY_EST = `COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END)`;

const SKIP_WORDS = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with', 'to', 'of'];

/**
 * Scan all enabled triggers for coverage data.
 * Finds best-reimbursing products per BIN/Group and backfills opportunity margins.
 *
 * @param {Object} options
 * @param {number} options.minClaims - Minimum claims to qualify (default: 1)
 * @param {number} options.daysBack - How far back to look (default: 365)
 * @param {number} options.minMargin - Minimum GP for standard triggers (default: 10)
 * @param {number} options.dmeMinMargin - Minimum GP for DME/NDC optimization triggers (default: 3)
 * @returns {Object} { summary, results, noMatches }
 */
export async function scanAllTriggerCoverage({ minClaims = 1, daysBack = 365, minMargin = 10, dmeMinMargin = 3 } = {}) {
  const startTime = Date.now();
  logger.info(`Starting bulk coverage verification (minMargin: $${minMargin}, dmeMinMargin: $${dmeMinMargin}, minClaims: ${minClaims}, daysBack: ${daysBack})`);

  const triggersResult = await db.query(`
    SELECT trigger_id, recommended_drug, recommended_ndc, display_name, detection_keywords, exclude_keywords, trigger_type, pharmacy_inclusions,
           expected_qty, expected_days_supply
    FROM triggers
    WHERE is_enabled = true
    ORDER BY display_name
  `);

  const triggers = triggersResult.rows;
  logger.info(`Found ${triggers.length} enabled triggers to verify`);

  const results = [];
  const noMatches = [];

  for (const trigger of triggers) {
    const isNdcOptimization = trigger.trigger_type === 'ndc_optimization';
    const effectiveMinMargin = isNdcOptimization ? dmeMinMargin : minMargin;

    let searchTerms = [];
    if (trigger.recommended_drug) {
      // Primary: use recommended_drug (the drug we're looking for coverage on)
      searchTerms = [trigger.recommended_drug];
    } else if (trigger.detection_keywords && Array.isArray(trigger.detection_keywords) && trigger.detection_keywords.length > 0) {
      // Fallback: use detection_keywords if no recommended_drug is set
      searchTerms = trigger.detection_keywords;
    }

    if (searchTerms.length === 0) {
      noMatches.push({ triggerId: trigger.trigger_id, triggerName: trigger.display_name, reason: 'No search criteria' });
      continue;
    }

    // Build keyword search conditions
    const searchGroups = [];
    const matchParams = [];
    let paramIndex = 1;

    for (const term of searchTerms) {
      const words = term
        .split(/[\s,.\-\(\)\[\]]+/)
        .map(w => w.trim().toUpperCase())
        .filter(w => w.length >= 2 && !SKIP_WORDS.includes(w.toLowerCase()) && !/^\d+$/.test(w));

      if (words.length > 0) {
        const groupConditions = words.map(word => {
          matchParams.push(word);
          // Use POSITION() instead of LIKE to avoid SQL wildcard issues
          // e.g. "2%" in LIKE matches "25MG" because % is a wildcard,
          // but POSITION('2%' IN 'DICLOFENAC POTASSIUM 25MG TAB') = 0 (no match)
          return `POSITION($${paramIndex++} IN UPPER(drug_name)) > 0`;
        });
        searchGroups.push(`(${groupConditions.join(' AND ')})`);
      }
    }

    const keywordConditions = searchGroups.length > 0 ? searchGroups.join(' OR ') : null;

    if (!keywordConditions) {
      noMatches.push({ triggerId: trigger.trigger_id, triggerName: trigger.display_name, reason: 'No valid search terms after filtering' });
      continue;
    }

    // Build exclude_keywords conditions
    let excludeCondition = '';
    const excludeKeywords = trigger.exclude_keywords || [];
    if (excludeKeywords.length > 0) {
      const excludeParts = excludeKeywords.map(kw => {
        const excludeWords = kw.split(/[\s,.\-\(\)\[\]]+/)
          .map(w => w.trim().toUpperCase())
          .filter(w => w.length >= 2);
        if (excludeWords.length === 0) return null;
        return '(' + excludeWords.map(word => {
          matchParams.push(word);
          return `POSITION($${paramIndex++} IN UPPER(drug_name)) > 0`;
        }).join(' AND ') + ')';
      }).filter(Boolean);
      if (excludeParts.length > 0) {
        excludeCondition = `AND NOT (${excludeParts.join(' OR ')})`;
      }
    }

    // Build query
    let matchQuery;
    const minClaimsParamIndex = matchParams.length + 1;
    matchParams.push(parseInt(minClaims));
    const daysBackParamIndex = matchParams.length + 1;
    matchParams.push(parseInt(daysBack));
    const minMarginParamIndex = matchParams.length + 1;
    matchParams.push(parseFloat(effectiveMinMargin));

    // Normalization strategy:
    // 1. If expected_qty is set: normalize GP per fill by dividing by whole-number fill multiples
    //    GP / ROUND(actual_qty / expected_qty) — e.g. qty 90 with expected 30 → GP/3
    //    Only divides by whole numbers (1, 2, 3...) to avoid fractional fill artifacts
    // 2. If only expected_days_supply is set: normalize via days supply ratio
    //    GP * (30 / actual_days) — useful for non-standard day supplies
    // 3. Default: standard 30-day normalization via CEIL (rounds to whole months)
    let gpNorm, qtyNorm, daysFilter;
    if (trigger.expected_qty) {
      // Qty-based normalization: divide GP by whole-number fill multiples
      // e.g. expected_qty=30: qty 90 → 3 fills → GP/3, qty 36 → 1 fill → GP/1
      const expectedQty = parseFloat(trigger.expected_qty);
      gpNorm = `${GP_SQL} / GREATEST(ROUND(COALESCE(quantity_dispensed, ${expectedQty})::numeric / ${expectedQty}), 1)`;
      qtyNorm = `${expectedQty}`;
      const minDays = trigger.expected_days_supply ? Math.floor(trigger.expected_days_supply * 0.8) : 20;
      daysFilter = `${DAYS_SUPPLY_EST} >= ${minDays}`;
    } else if (trigger.expected_days_supply) {
      // Days-based normalization: scale raw GP to 30-day equivalent
      gpNorm = `${GP_SQL} * (30.0 / GREATEST(${DAYS_SUPPLY_EST}::numeric, 1))`;
      qtyNorm = `COALESCE(quantity_dispensed, 1) * (30.0 / GREATEST(${DAYS_SUPPLY_EST}::numeric, 1))`;
      const minDays = Math.floor(trigger.expected_days_supply * 0.8);
      daysFilter = `${DAYS_SUPPLY_EST} >= ${minDays}`;
    } else {
      // Default: standard 30-day normalization via CEIL (rounds to whole months)
      gpNorm = `${GP_SQL} / GREATEST(CEIL(${DAYS_SUPPLY_EST}::numeric / 30.0), 1)`;
      qtyNorm = `COALESCE(quantity_dispensed, 1) / GREATEST(CEIL(${DAYS_SUPPLY_EST}::numeric / 30.0), 1)`;
      daysFilter = `${DAYS_SUPPLY_EST} >= 28`;
    }

    // Shared filters: require valid drug name and GP > 0
    // Don't require qty > 0 — some PMS exports (e.g. Aracoma/RX30) lack quantity columns
    // but still have valid GP data. Claims without qty normalize using days_supply estimate.
    const dataQualityFilter = `AND drug_name IS NOT NULL AND TRIM(drug_name) != ''`;
    const gpPositiveFilter = `AND ${GP_SQL} > 0`;

    // Fetch excluded BINs for this trigger so we don't include them in results
    const excludedBinsResult = await db.query(`
      SELECT insurance_bin, COALESCE(insurance_group, '') as insurance_group
      FROM trigger_bin_values
      WHERE trigger_id = $1 AND is_excluded = true
    `, [trigger.trigger_id]);
    let binExclusionCondition = '';
    if (excludedBinsResult.rows.length > 0) {
      // Sync paramIndex with actual matchParams length (minClaims/daysBack/minMargin were pushed above)
      paramIndex = matchParams.length + 1;
      const excludedPairs = excludedBinsResult.rows.map(r => {
        matchParams.push(r.insurance_bin);
        const binIdx = paramIndex++;
        matchParams.push(r.insurance_group);
        const grpIdx = paramIndex++;
        return `(insurance_bin = $${binIdx} AND COALESCE(insurance_group, '') = $${grpIdx})`;
      });
      binExclusionCondition = `AND NOT (${excludedPairs.join(' OR ')})`;
    }

    // Claims with qty=0 count toward coverage presence (claim_count) but
    // their GP/qty are NULLed out so they don't skew the median estimates.
    // PERCENTILE_CONT ignores NULLs automatically.
    const gpCol = `CASE WHEN COALESCE(quantity_dispensed, 0) > 0 THEN ${gpNorm} ELSE NULL END`;
    const qtyCol = `CASE WHEN COALESCE(quantity_dispensed, 0) > 0 THEN ${qtyNorm} ELSE NULL END`;

    if (isNdcOptimization) {
      matchQuery = `
        WITH raw_claims AS (
          SELECT insurance_bin as bin, insurance_group as grp, drug_name, ndc,
            ${gpCol} as gp_30day, ${qtyCol} as qty_30day
          FROM prescriptions
          WHERE ${keywordConditions ? `(${keywordConditions})` : 'FALSE'}
            ${excludeCondition}
            AND insurance_bin IS NOT NULL AND insurance_bin != ''
            AND ${daysFilter}
            ${dataQualityFilter}
            ${gpPositiveFilter}
            ${binExclusionCondition}
            AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackParamIndex}
        ),
        per_product AS (
          SELECT bin, grp, drug_name, ndc,
            COUNT(*) as claim_count,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gp_30day) as avg_margin,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY qty_30day) as avg_qty
          FROM raw_claims
          GROUP BY bin, grp, drug_name, ndc
          HAVING COUNT(*) >= $${minClaimsParamIndex}
            AND PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gp_30day) >= $${minMarginParamIndex}
        ),
        ranked_products AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY bin, grp ORDER BY avg_margin DESC) as rank
          FROM per_product
        )
        SELECT bin, grp as "group", drug_name as best_drug, ndc as best_ndc, claim_count, avg_margin, avg_qty
        FROM ranked_products WHERE rank = 1
        ORDER BY avg_margin DESC
      `;
    } else {
      // Same ranked_products approach as NDC path — pick best product per BIN/GROUP
      matchQuery = `
        WITH raw_claims AS (
          SELECT insurance_bin as bin, insurance_group as grp, drug_name, ndc,
            ${gpCol} as gp_30day, ${qtyCol} as qty_30day
          FROM prescriptions
          WHERE ${keywordConditions ? `(${keywordConditions})` : 'FALSE'}
            ${excludeCondition}
            AND insurance_bin IS NOT NULL AND insurance_bin != ''
            AND ${daysFilter}
            ${dataQualityFilter}
            ${gpPositiveFilter}
            ${binExclusionCondition}
            AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackParamIndex}
        ),
        per_product AS (
          SELECT bin, grp, drug_name, ndc,
            COUNT(*) as claim_count,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gp_30day) as avg_margin,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY qty_30day) as avg_qty
          FROM raw_claims
          GROUP BY bin, grp, drug_name, ndc
          HAVING COUNT(*) >= $${minClaimsParamIndex}
            AND PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY gp_30day) >= $${minMarginParamIndex}
        ),
        ranked_products AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY bin, grp ORDER BY avg_margin DESC NULLS LAST) as rank
          FROM per_product
        )
        SELECT bin, grp as "group", drug_name as best_drug, ndc as best_ndc, claim_count, avg_margin, avg_qty
        FROM ranked_products WHERE rank = 1
        ORDER BY avg_margin DESC
      `;
    }

    const matches = await db.query(matchQuery, matchParams);

    if (matches.rows.length === 0) {
      noMatches.push({ triggerId: trigger.trigger_id, triggerName: trigger.display_name, reason: `No claims found with margin >= $${effectiveMinMargin}` });
      // Just update synced_at so admin can see it was scanned — don't auto-disable
      await db.query(`UPDATE triggers SET synced_at = NOW() WHERE trigger_id = $1`, [trigger.trigger_id]);
      continue;
    }

    // Clear stale BIN values from previous scans (preserve manually excluded entries)
    await db.query(`
      DELETE FROM trigger_bin_values
      WHERE trigger_id = $1 AND (is_excluded = false OR is_excluded IS NULL)
    `, [trigger.trigger_id]);

    // Upsert matches into trigger_bin_values
    let verifiedCount = 0;
    for (const match of matches.rows) {
      await db.query(`
        INSERT INTO trigger_bin_values (
          trigger_id, insurance_bin, insurance_group, coverage_status,
          verified_at, verified_claim_count, avg_reimbursement, gp_value,
          best_drug_name, best_ndc, avg_qty
        )
        VALUES ($1, $2, $3, 'verified', NOW(), $4, $5, $5, $6, $7, $8)
        ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
        DO UPDATE SET
          coverage_status = 'verified',
          verified_at = NOW(),
          verified_claim_count = $4,
          avg_reimbursement = $5,
          gp_value = $5,
          best_drug_name = $6,
          best_ndc = $7,
          avg_qty = $8
      `, [
        trigger.trigger_id,
        match.bin,
        match.group || null,
        parseInt(match.claim_count),
        parseFloat(match.avg_margin) || 0,
        match.best_drug || null,
        match.best_ndc || null,
        parseFloat(match.avg_qty) || null
      ]);
      verifiedCount++;
    }

    // Auto-update trigger's default_gp_value from claim-count-weighted median
    if (matches.rows.length > 0) {
      // Weighted median: BIN/GROUPs with more claims have more influence on the default
      // This prevents a single outlier BIN with 1 claim from skewing the default
      const entries = matches.rows
        .map(m => ({ gp: parseFloat(m.avg_margin) || 0, weight: parseInt(m.claim_count) || 1 }))
        .filter(e => e.gp > 0)
        .sort((a, b) => a.gp - b.gp);
      const totalWeight = entries.reduce((sum, e) => sum + e.weight, 0);
      let medianGP = 0;
      if (entries.length > 0) {
        let cumWeight = 0;
        for (const entry of entries) {
          cumWeight += entry.weight;
          if (cumWeight >= totalWeight / 2) { medianGP = entry.gp; break; }
        }
      }
      console.log(`Default GP for ${trigger.display_name}: weighted median=$${medianGP.toFixed(2)} from ${entries.length} BIN/GROUPs (${totalWeight} total claims)`);

      // Only update default_gp_value and synced_at — do NOT overwrite recommended_ndc
      // The trigger's recommended_ndc is admin-configured and should not be auto-replaced
      // by whatever the scanner finds as highest GP (which could be a different formulation)
      await db.query(`
        UPDATE triggers SET
          default_gp_value = $1,
          synced_at = NOW()
        WHERE trigger_id = $2
      `, [medianGP, trigger.trigger_id]);

      // Backfill "Not Submitted" opportunities with updated GP values, qty, and NDC
      await db.query(`
        UPDATE opportunities o SET
          potential_margin_gain = ROUND(
            COALESCE(
              (SELECT tbv.gp_value
               FROM prescriptions rx
               JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
                 AND tbv.insurance_bin = rx.insurance_bin
                 AND COALESCE(tbv.insurance_group, '') = COALESCE(rx.insurance_group, '')
                 AND tbv.is_excluded = false
               WHERE rx.prescription_id = o.prescription_id
               LIMIT 1),
              $2
            ), 2
          ),
          annual_margin_gain = ROUND(
            COALESCE(
              (SELECT tbv.gp_value
               FROM prescriptions rx
               JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
                 AND tbv.insurance_bin = rx.insurance_bin
                 AND COALESCE(tbv.insurance_group, '') = COALESCE(rx.insurance_group, '')
                 AND tbv.is_excluded = false
               WHERE rx.prescription_id = o.prescription_id
               LIMIT 1),
              $2
            ) * COALESCE(
              (SELECT t.annual_fills FROM triggers t WHERE t.trigger_id = o.trigger_id),
              12
            ), 2
          ),
          avg_dispensed_qty = COALESCE(
            (SELECT tbv.avg_qty
             FROM prescriptions rx
             JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
               AND tbv.insurance_bin = rx.insurance_bin
               AND COALESCE(tbv.insurance_group, '') = COALESCE(rx.insurance_group, '')
               AND tbv.is_excluded = false
             WHERE rx.prescription_id = o.prescription_id
             LIMIT 1),
            o.avg_dispensed_qty
          ),
          recommended_ndc = COALESCE(
            (SELECT tbv.best_ndc
             FROM prescriptions rx
             JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
               AND tbv.insurance_bin = rx.insurance_bin
               AND COALESCE(tbv.insurance_group, '') = COALESCE(rx.insurance_group, '')
               AND tbv.is_excluded = false
             WHERE rx.prescription_id = o.prescription_id
             LIMIT 1),
            o.recommended_ndc
          ),
          recommended_drug = COALESCE(
            (SELECT tbv.best_drug_name
             FROM prescriptions rx
             JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
               AND tbv.insurance_bin = rx.insurance_bin
               AND COALESCE(tbv.insurance_group, '') = COALESCE(rx.insurance_group, '')
               AND tbv.is_excluded = false
             WHERE rx.prescription_id = o.prescription_id
             LIMIT 1),
            o.recommended_drug
          ),
          updated_at = NOW()
        WHERE o.trigger_id = $1
          AND o.status = 'Not Submitted'
      `, [trigger.trigger_id, medianGP]);
    }

    // Collect drug variation stats
    const drugVariationMap = new Map();
    for (const m of matches.rows) {
      const name = (m.best_drug || '').toUpperCase();
      if (!name) continue;
      const existing = drugVariationMap.get(name) || { claimCount: 0, ndcs: new Set() };
      existing.claimCount += parseInt(m.claim_count) || 0;
      if (m.best_ndc) existing.ndcs.add(m.best_ndc);
      drugVariationMap.set(name, existing);
    }
    const drugVariations = Array.from(drugVariationMap.entries())
      .map(([name, data]) => ({ drugName: name, claimCount: data.claimCount, ndcs: Array.from(data.ndcs).slice(0, 5) }))
      .sort((a, b) => b.claimCount - a.claimCount);

    results.push({
      triggerId: trigger.trigger_id,
      triggerName: trigger.display_name,
      triggerType: trigger.trigger_type,
      verifiedCount,
      topBins: matches.rows.slice(0, 3).map(m => ({
        bin: m.bin, group: m.group, bestDrug: m.best_drug,
        avgMargin: parseFloat(m.avg_margin).toFixed(2),
        avgQty: parseFloat(m.avg_qty || 0).toFixed(1)
      })),
      drugVariations
    });
  }

  // Pharmacy scope cleanup: delete "Not Submitted" opportunities for out-of-scope pharmacies
  let totalScopeDeleted = 0;
  for (const trigger of triggers) {
    const pharmacyInclusions = trigger.pharmacy_inclusions || [];
    if (pharmacyInclusions.length > 0) {
      const deleted = await db.query(`
        DELETE FROM opportunities
        WHERE trigger_id = $1
          AND status = 'Not Submitted'
          AND pharmacy_id != ALL($2::uuid[])
        RETURNING opportunity_id
      `, [trigger.trigger_id, pharmacyInclusions]);
      if (deleted.rowCount > 0) {
        totalScopeDeleted += deleted.rowCount;
        logger.info(`Deleted ${deleted.rowCount} out-of-scope opportunities for trigger "${trigger.display_name}"`, {
          triggerId: trigger.trigger_id,
          allowedPharmacies: pharmacyInclusions.length
        });
      }
    }
  }
  if (totalScopeDeleted > 0) {
    logger.info(`Pharmacy scope cleanup: deleted ${totalScopeDeleted} total out-of-scope opportunities`);
  }

  const duration = Date.now() - startTime;
  logger.info(`Bulk verification complete: ${results.length} triggers with matches, ${noMatches.length} with no matches (${duration}ms)`);

  return {
    summary: {
      totalTriggers: triggers.length,
      triggersWithMatches: results.length,
      triggersWithNoMatches: noMatches.length,
      minMarginUsed: minMargin,
      dmeMinMarginUsed: dmeMinMargin,
      outOfScopeDeleted: totalScopeDeleted,
      duration
    },
    results,
    noMatches
  };
}
