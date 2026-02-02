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
    if (isNdcOptimization && trigger.detection_keywords && Array.isArray(trigger.detection_keywords) && trigger.detection_keywords.length > 0) {
      searchTerms = trigger.detection_keywords;
    } else if (trigger.recommended_drug) {
      searchTerms = [trigger.recommended_drug];
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

    // When expected_days_supply is set, use it for more accurate 30-day normalization
    // e.g. test strips: 100/25 days → GP * (30/25) gives true 30-day GP
    // Without it, CEIL(25/30) = 1, so no normalization happens (undercounting)
    let gpNorm, qtyNorm, daysFilter;
    if (trigger.expected_days_supply) {
      // Accurate normalization: scale raw GP to 30-day equivalent using expected fill cadence
      // raw_GP * (30 / actual_days) gives the correct 30-day value
      gpNorm = `${GP_SQL} * (30.0 / GREATEST(${DAYS_SUPPLY_EST}::numeric, 1))`;
      qtyNorm = `COALESCE(quantity_dispensed, 1) * (30.0 / GREATEST(${DAYS_SUPPLY_EST}::numeric, 1))`;
      // Lower the days filter threshold when expected supply is < 28 days
      const minDays = Math.floor(trigger.expected_days_supply * 0.8);
      daysFilter = `${DAYS_SUPPLY_EST} >= ${minDays}`;
    } else {
      // Default: standard 30-day normalization via CEIL (rounds to whole months)
      gpNorm = `${GP_SQL} / GREATEST(CEIL(${DAYS_SUPPLY_EST}::numeric / 30.0), 1)`;
      qtyNorm = `COALESCE(quantity_dispensed, 1) / GREATEST(CEIL(${DAYS_SUPPLY_EST}::numeric / 30.0), 1)`;
      daysFilter = `${DAYS_SUPPLY_EST} >= 28`;
    }

    if (isNdcOptimization) {
      matchQuery = `
        WITH raw_claims AS (
          SELECT insurance_bin as bin, insurance_group as grp, drug_name, ndc,
            ${gpNorm} as gp_30day, ${qtyNorm} as qty_30day
          FROM prescriptions
          WHERE ${keywordConditions ? `(${keywordConditions})` : 'FALSE'}
            ${excludeCondition}
            AND insurance_bin IS NOT NULL AND insurance_bin != ''
            AND ${daysFilter}
            AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackParamIndex}
        ),
        ranked_products AS (
          SELECT bin, grp, drug_name, ndc,
            COUNT(*) as claim_count, AVG(gp_30day) as avg_margin, AVG(qty_30day) as avg_qty,
            ROW_NUMBER() OVER (PARTITION BY bin, grp ORDER BY AVG(gp_30day) DESC) as rank
          FROM raw_claims
          GROUP BY bin, grp, drug_name, ndc
          HAVING COUNT(*) >= $${minClaimsParamIndex} AND AVG(gp_30day) >= $${minMarginParamIndex}
        )
        SELECT bin, grp as "group", drug_name as best_drug, ndc as best_ndc, claim_count, avg_margin, avg_qty
        FROM ranked_products WHERE rank = 1
        ORDER BY avg_margin DESC
      `;
    } else {
      matchQuery = `
        WITH raw_claims AS (
          SELECT insurance_bin as bin, insurance_group as grp, drug_name, ndc,
            ${gpNorm} as gp_30day, ${qtyNorm} as qty_30day
          FROM prescriptions
          WHERE ${keywordConditions ? `(${keywordConditions})` : 'FALSE'}
            ${excludeCondition}
            AND insurance_bin IS NOT NULL AND insurance_bin != ''
            AND ${daysFilter}
            AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackParamIndex}
        )
        SELECT bin, grp as "group", drug_name as best_drug, ndc as best_ndc,
          COUNT(*) as claim_count, AVG(gp_30day) as avg_margin, AVG(qty_30day) as avg_qty
        FROM raw_claims
        GROUP BY bin, grp, drug_name, ndc
        HAVING COUNT(*) >= $${minClaimsParamIndex} AND AVG(gp_30day) >= $${minMarginParamIndex}
        ORDER BY avg_margin DESC
      `;
    }

    const matches = await db.query(matchQuery, matchParams);

    if (matches.rows.length === 0) {
      noMatches.push({ triggerId: trigger.trigger_id, triggerName: trigger.display_name, reason: `No claims found with margin >= $${effectiveMinMargin}` });
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

    // Auto-update trigger's default_gp_value from median coverage GP
    if (matches.rows.length > 0) {
      // Use median GP across all BIN/Groups (not max) to keep estimates reasonable
      const gpValues = matches.rows
        .map(m => parseFloat(m.avg_margin) || 0)
        .filter(gp => gp > 0)
        .sort((a, b) => a - b);
      const medianGP = gpValues.length > 0
        ? gpValues.length % 2 === 0
          ? (gpValues[gpValues.length / 2 - 1] + gpValues[gpValues.length / 2]) / 2
          : gpValues[Math.floor(gpValues.length / 2)]
        : 0;

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
          updated_at = NOW()
        WHERE o.trigger_id = $1
          AND o.status = 'Not Submitted'
      `, [trigger.trigger_id, medianGP]);
    } else {
      // No coverage found — auto-disable trigger so admin can identify which need fixing
      await db.query(`
        UPDATE triggers SET is_enabled = false, synced_at = NOW()
        WHERE trigger_id = $1 AND is_enabled = true
      `, [trigger.trigger_id]);
      logger.info(`Auto-disabled trigger "${trigger.display_name}" — 0 coverage results`);
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
