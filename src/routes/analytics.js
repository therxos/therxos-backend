// Analytics routes for TheRxOS V2
import express from 'express';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';
import glp1Scanner from '../services/glp1-audit-scanner.js';
import { formatPatientName, formatPrescriberName } from '../utils/formatters.js';
import { cached } from '../utils/cache.js';

const router = express.Router();

// Cache TTLs
const CACHE_5MIN = 5 * 60 * 1000;
const CACHE_10MIN = 10 * 60 * 1000;

// Dashboard overview stats
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { period = '30' } = req.query;
    const days = parseInt(period);

    // Get pharmacy's disabled triggers for filtering
    const settingsResult = await db.query(
      'SELECT settings FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );
    const disabledTriggers = settingsResult.rows[0]?.settings?.disabledTriggers || [];
    const cacheKey = `pharmacy:${pharmacyId}:dashboard:${days}:dt${disabledTriggers.length}`;

    const data = await cached(cacheKey, async () => {
      const cleanOppFilter = `AND opportunity_id NOT IN (
        SELECT dqi.opportunity_id FROM data_quality_issues dqi
        WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
      )`;
      const disabledTriggerFilter = disabledTriggers.length > 0
        ? `AND (trigger_id IS NULL OR trigger_id NOT IN (${disabledTriggers.map(id => `'${id}'`).join(',')}))`
        : '';
      // Aliased version for CTE with table prefix
      const dtFilterAliased = disabledTriggers.length > 0
        ? `AND (o.trigger_id IS NULL OR o.trigger_id NOT IN (${disabledTriggers.map(id => `'${id}'`).join(',')}))`
        : '';

      const overview = await db.query(`
        WITH pending_cov AS (
          SELECT o.potential_margin_gain,
            CASE WHEN o.trigger_id IS NULL THEN true
                 WHEN tbv.coverage_status IN ('verified', 'works') THEN true
                 WHEN COALESCE(tbv.verified_claim_count, 0) > 0 THEN true
                 ELSE false
            END as has_coverage
          FROM opportunities o
          LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
          LEFT JOIN patients p ON p.patient_id = o.patient_id
          LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
            AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin, '')
            AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
          WHERE o.pharmacy_id = $1 AND o.status = 'Not Submitted'
            AND o.opportunity_id NOT IN (
              SELECT dqi.opportunity_id FROM data_quality_issues dqi
              WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
            )
            AND (tbv.is_excluded IS NOT TRUE AND COALESCE(tbv.coverage_status, '') != 'excluded')
            ${dtFilterAliased}
        )
        SELECT
          (SELECT COUNT(*) FROM pending_cov) as pending_opportunities,
          (SELECT COALESCE(SUM(potential_margin_gain), 0) FROM pending_cov WHERE has_coverage) as pending_margin,
          (SELECT COUNT(*) FROM pending_cov WHERE NOT has_coverage) as unknown_coverage_count,
          (SELECT COALESCE(SUM(potential_margin_gain), 0) FROM pending_cov WHERE NOT has_coverage) as unknown_coverage_margin,
          (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status IN ('Submitted', 'Approved', 'Completed') AND actioned_at >= NOW() - INTERVAL '${days} days' ${disabledTriggerFilter}) as actioned_count,
          (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Completed' ${disabledTriggerFilter}) as completed_count,
          (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = $1 AND status = 'Completed' ${disabledTriggerFilter}) as completed_value,
          (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Approved' ${disabledTriggerFilter}) as approved_count,
          (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = $1 AND status = 'Approved' ${disabledTriggerFilter}) as approved_value,
          (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status IN ('Approved', 'Completed') ${disabledTriggerFilter}) as captured_count,
          (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = $1 AND status IN ('Approved', 'Completed') ${disabledTriggerFilter}) as captured_value,
          (SELECT COUNT(*) FROM prescriptions WHERE pharmacy_id = $1 AND dispensed_date >= NOW() - INTERVAL '${days} days') as rx_count,
          (SELECT COUNT(DISTINCT patient_id) FROM prescriptions WHERE pharmacy_id = $1 AND dispensed_date >= NOW() - INTERVAL '${days} days') as active_patients,
          (SELECT COUNT(*) FROM patients WHERE pharmacy_id = $1) as total_patients,
          (SELECT COUNT(*) FROM patients WHERE pharmacy_id = $1 AND med_sync_enrolled = true) as med_sync_patients,
          (SELECT
            CASE WHEN COUNT(*) > 0
            THEN ROUND(100.0 * COUNT(*) FILTER (WHERE status NOT IN ('Not Submitted', 'Denied', 'Declined')) / COUNT(*), 1)
            ELSE 0 END
          FROM opportunities
          WHERE pharmacy_id = $1 ${disabledTriggerFilter}) as action_rate
      `, [pharmacyId]);
      return overview.rows[0];
    }, CACHE_5MIN);

    res.json(data);
  } catch (error) {
    logger.error('Dashboard stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get dashboard stats' });
  }
});

// Opportunity breakdown by type
router.get('/opportunities/by-type', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { status = 'Not Submitted' } = req.query;

    // CRITICAL: Only filter data quality issues for 'Not Submitted' - NEVER filter worked opportunities
    const dataQualityFilter = status === 'Not Submitted' ? `
        AND opportunity_id NOT IN (
          SELECT dqi.opportunity_id FROM data_quality_issues dqi
          WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
        )` : '';

    const result = await db.query(`
      SELECT
        opportunity_type,
        COUNT(*) as count,
        COALESCE(SUM(potential_margin_gain), 0) as total_margin,
        COALESCE(AVG(potential_margin_gain), 0) as avg_margin,
        COUNT(DISTINCT patient_id) as patient_count
      FROM opportunities
      WHERE pharmacy_id = $1 AND status = $2
        ${dataQualityFilter}
      GROUP BY opportunity_type
      ORDER BY total_margin DESC
    `, [pharmacyId, status]);

    res.json(result.rows);
  } catch (error) {
    logger.error('Opportunity breakdown error', { error: error.message });
    res.status(500).json({ error: 'Failed to get breakdown' });
  }
});

// Trend data over time
router.get('/trends', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { days = 30, granularity = 'day' } = req.query;

    const truncate = granularity === 'week' ? 'week' : granularity === 'month' ? 'month' : 'day';

    const opportunities = await db.query(`
      SELECT 
        DATE_TRUNC('${truncate}', created_at) as period,
        COUNT(*) as identified,
        COUNT(*) FILTER (WHERE status = 'actioned') as actioned,
        COALESCE(SUM(potential_margin_gain), 0) as potential_margin,
        COALESCE(SUM(actual_margin_realized) FILTER (WHERE status = 'actioned'), 0) as realized_margin
      FROM opportunities
      WHERE pharmacy_id = $1 AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE_TRUNC('${truncate}', created_at)
      ORDER BY period ASC
    `, [pharmacyId]);

    const prescriptions = await db.query(`
      SELECT 
        DATE_TRUNC('${truncate}', dispensed_date) as period,
        COUNT(*) as rx_count,
        COUNT(DISTINCT patient_id) as patient_count
      FROM prescriptions
      WHERE pharmacy_id = $1 AND dispensed_date >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE_TRUNC('${truncate}', dispensed_date)
      ORDER BY period ASC
    `, [pharmacyId]);

    res.json({
      opportunities: opportunities.rows,
      prescriptions: prescriptions.rows
    });
  } catch (error) {
    logger.error('Trends error', { error: error.message });
    res.status(500).json({ error: 'Failed to get trends' });
  }
});

// Top opportunity patients
router.get('/top-patients', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { limit = 10 } = req.query;

    const result = await db.query(`
      SELECT
        p.patient_id,
        p.patient_hash,
        p.first_name,
        p.last_name,
        p.chronic_conditions,
        COUNT(o.opportunity_id) as opportunity_count,
        COALESCE(SUM(o.potential_margin_gain), 0) as total_margin,
        (SELECT MAX(dispensed_date) FROM prescriptions WHERE patient_id = p.patient_id) as last_visit
      FROM patients p
      JOIN opportunities o ON o.patient_id = p.patient_id AND o.status = 'Not Submitted'
      WHERE p.pharmacy_id = $1
      GROUP BY p.patient_id, p.patient_hash, p.first_name, p.last_name, p.chronic_conditions
      ORDER BY total_margin DESC
      LIMIT $2
    `, [pharmacyId, parseInt(limit)]);

    // Format patient names for display
    const formattedPatients = result.rows.map(p => ({
      ...p,
      patient_name: formatPatientName(p.first_name, p.last_name)
    }));

    res.json(formattedPatients);
  } catch (error) {
    logger.error('Top patients error', { error: error.message });
    res.status(500).json({ error: 'Failed to get top patients' });
  }
});

// Performance comparison (vs previous period)
router.get('/performance', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { days = 30 } = req.query;
    const periodDays = parseInt(days);

    const current = await db.query(`
      SELECT
        COUNT(*) as opportunities,
        COALESCE(SUM(potential_margin_gain), 0) as potential_margin,
        COALESCE(SUM(actual_margin_realized) FILTER (WHERE status = 'actioned'), 0) as realized_margin,
        COUNT(*) FILTER (WHERE status = 'actioned') as actioned
      FROM opportunities
      WHERE pharmacy_id = $1 AND created_at >= NOW() - INTERVAL '${periodDays} days'
    `, [pharmacyId]);

    const previous = await db.query(`
      SELECT
        COUNT(*) as opportunities,
        COALESCE(SUM(potential_margin_gain), 0) as potential_margin,
        COALESCE(SUM(actual_margin_realized) FILTER (WHERE status = 'actioned'), 0) as realized_margin,
        COUNT(*) FILTER (WHERE status = 'actioned') as actioned
      FROM opportunities
      WHERE pharmacy_id = $1 
        AND created_at >= NOW() - INTERVAL '${periodDays * 2} days'
        AND created_at < NOW() - INTERVAL '${periodDays} days'
    `, [pharmacyId]);

    const calc = (curr, prev) => {
      if (prev === 0) return curr > 0 ? 100 : 0;
      return Math.round(((curr - prev) / prev) * 100);
    };

    res.json({
      current: current.rows[0],
      previous: previous.rows[0],
      changes: {
        opportunities: calc(current.rows[0].opportunities, previous.rows[0].opportunities),
        potential_margin: calc(current.rows[0].potential_margin, previous.rows[0].potential_margin),
        realized_margin: calc(current.rows[0].realized_margin, previous.rows[0].realized_margin),
        actioned: calc(current.rows[0].actioned, previous.rows[0].actioned)
      }
    });
  } catch (error) {
    logger.error('Performance error', { error: error.message });
    res.status(500).json({ error: 'Failed to get performance data' });
  }
});

// Ingestion status
router.get('/ingestion-status', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;

    const recent = await db.query(`
      SELECT *
      FROM ingestion_logs
      WHERE pharmacy_id = $1
      ORDER BY started_at DESC
      LIMIT 10
    `, [pharmacyId]);

    const summary = await db.query(`
      SELECT
        COUNT(*) as total_ingestions,
        SUM(successful_records) as total_records,
        MAX(completed_at) as last_ingestion,
        AVG(processing_time_ms) as avg_processing_time
      FROM ingestion_logs
      WHERE pharmacy_id = $1 AND started_at >= NOW() - INTERVAL '7 days'
    `, [pharmacyId]);

    res.json({
      recent: recent.rows,
      summary: summary.rows[0]
    });
  } catch (error) {
    logger.error('Ingestion status error', { error: error.message });
    res.status(500).json({ error: 'Failed to get ingestion status' });
  }
});

// GP/Rx Metrics - pharmacy-wide, by BIN, by Group, by Prescriber
router.get('/gp-metrics', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const cacheKey = `pharmacy:${pharmacyId}:gp-metrics`;

    const data = await cached(cacheKey, async () => {
    // Pharmacy-wide GP/Rx
    const pharmacyWide = await db.query(`
      SELECT
        COUNT(*) as total_rx_count,
        COALESCE(SUM(
          COALESCE(
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
              REPLACE(COALESCE(raw_data->>'Price','0'), '$', '')::numeric
              - REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', '')::numeric,
            0),
            0
          )
        ), 0) as total_gross_profit,
        CASE
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(
            COALESCE(
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
                REPLACE(COALESCE(raw_data->>'Price','0'), '$', '')::numeric
                - REPLACE(COALESCE(raw_data->>'Actual Cost','0'), '$', '')::numeric,
              0),
              0
            )
          ), 0) / COUNT(*)
          ELSE 0
        END as gp_per_rx
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND dispensed_date >= NOW() - INTERVAL '365 days'
    `, [pharmacyId]);

    // Total opportunity impact
    const opportunityImpact = await db.query(`
      SELECT COALESCE(SUM(annual_margin_gain), 0) as opportunity_impact
      FROM opportunities
      WHERE pharmacy_id = $1 AND status = 'Not Submitted'
    `, [pharmacyId]);

    // Calculate projected GP/Rx
    const totalRx = parseInt(pharmacyWide.rows[0].total_rx_count) || 1;
    const totalGP = parseFloat(pharmacyWide.rows[0].total_gross_profit) || 0;
    const oppImpact = parseFloat(opportunityImpact.rows[0].opportunity_impact) || 0;
    const projectedGpPerRx = (totalGP + oppImpact) / totalRx;

    // GP/Rx by BIN
    const byBin = await db.query(`
      SELECT
        COALESCE(pr.insurance_bin, 'Unknown') as bin,
        COUNT(*) as rx_count,
        COALESCE(SUM(
          COALESCE(
            NULLIF(REPLACE(pr.raw_data->>'gross_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Gross Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'grossprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'GrossProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'net_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Net Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'netprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'NetProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adj_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Adj Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adjprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'AdjProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adjusted_profit', ',', '')::numeric, 0),
            NULLIF(
              REPLACE(COALESCE(pr.raw_data->>'Price','0'), '$', '')::numeric
              - REPLACE(COALESCE(pr.raw_data->>'Actual Cost','0'), '$', '')::numeric,
            0),
            COALESCE((pr.raw_data->>'gross_profit')::numeric, (pr.raw_data->>'net_profit')::numeric, (pr.raw_data->>'Gross Profit')::numeric, (pr.raw_data->>'Net Profit')::numeric, 0)
          )
        ), 0) as gross_profit,
        CASE
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(
            COALESCE(
              NULLIF(REPLACE(pr.raw_data->>'gross_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Gross Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'grossprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'GrossProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'net_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Net Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'netprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'NetProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adj_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Adj Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adjprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'AdjProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adjusted_profit', ',', '')::numeric, 0),
              NULLIF(
                REPLACE(COALESCE(pr.raw_data->>'Price','0'), '$', '')::numeric
                - REPLACE(COALESCE(pr.raw_data->>'Actual Cost','0'), '$', '')::numeric,
              0),
              COALESCE((pr.raw_data->>'gross_profit')::numeric, (pr.raw_data->>'net_profit')::numeric, (pr.raw_data->>'Gross Profit')::numeric, (pr.raw_data->>'Net Profit')::numeric, 0)
            )
          ), 0) / COUNT(*)
          ELSE 0
        END as gp_per_rx,
        COUNT(DISTINCT o.opportunity_id) as opportunity_count,
        COALESCE(SUM(DISTINCT o.annual_margin_gain), 0) as opportunity_value
      FROM prescriptions pr
      LEFT JOIN opportunities o ON o.prescription_id = pr.prescription_id AND o.status = 'Not Submitted'
      WHERE pr.pharmacy_id = $1
        AND pr.dispensed_date >= NOW() - INTERVAL '365 days'
      GROUP BY COALESCE(pr.insurance_bin, 'Unknown')
      ORDER BY gross_profit DESC
    `, [pharmacyId]);

    // GP/Rx by BIN + Group
    const byGroup = await db.query(`
      SELECT
        COALESCE(pr.insurance_bin, 'Unknown') as bin,
        COALESCE(pr.insurance_group, 'Unknown') as "group",
        COUNT(*) as rx_count,
        COALESCE(SUM(
          COALESCE(
            NULLIF(REPLACE(pr.raw_data->>'gross_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Gross Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'grossprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'GrossProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'net_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Net Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'netprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'NetProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adj_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Adj Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adjprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'AdjProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adjusted_profit', ',', '')::numeric, 0),
            NULLIF(
              REPLACE(COALESCE(pr.raw_data->>'Price','0'), '$', '')::numeric
              - REPLACE(COALESCE(pr.raw_data->>'Actual Cost','0'), '$', '')::numeric,
            0),
            COALESCE((pr.raw_data->>'gross_profit')::numeric, (pr.raw_data->>'net_profit')::numeric, (pr.raw_data->>'Gross Profit')::numeric, (pr.raw_data->>'Net Profit')::numeric, 0)
          )
        ), 0) as gross_profit,
        CASE
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(
            COALESCE(
              NULLIF(REPLACE(pr.raw_data->>'gross_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Gross Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'grossprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'GrossProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'net_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Net Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'netprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'NetProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adj_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Adj Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adjprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'AdjProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adjusted_profit', ',', '')::numeric, 0),
              NULLIF(
                REPLACE(COALESCE(pr.raw_data->>'Price','0'), '$', '')::numeric
                - REPLACE(COALESCE(pr.raw_data->>'Actual Cost','0'), '$', '')::numeric,
              0),
              COALESCE((pr.raw_data->>'gross_profit')::numeric, (pr.raw_data->>'net_profit')::numeric, (pr.raw_data->>'Gross Profit')::numeric, (pr.raw_data->>'Net Profit')::numeric, 0)
            )
          ), 0) / COUNT(*)
          ELSE 0
        END as gp_per_rx,
        COUNT(DISTINCT o.opportunity_id) as opportunity_count,
        COALESCE(SUM(DISTINCT o.annual_margin_gain), 0) as opportunity_value
      FROM prescriptions pr
      LEFT JOIN opportunities o ON o.prescription_id = pr.prescription_id AND o.status = 'Not Submitted'
      WHERE pr.pharmacy_id = $1
        AND pr.dispensed_date >= NOW() - INTERVAL '365 days'
      GROUP BY COALESCE(pr.insurance_bin, 'Unknown'), COALESCE(pr.insurance_group, 'Unknown')
      ORDER BY gross_profit DESC
      LIMIT 50
    `, [pharmacyId]);

    // GP/Rx by Prescriber
    const byPrescriber = await db.query(`
      SELECT
        COALESCE(pr.prescriber_name, 'Unknown') as prescriber_name,
        COUNT(*) as rx_count,
        COALESCE(SUM(
          COALESCE(
            NULLIF(REPLACE(pr.raw_data->>'gross_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Gross Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'grossprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'GrossProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'net_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Net Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'netprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'NetProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adj_profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Adj Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adjprofit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'AdjProfit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
            NULLIF(REPLACE(pr.raw_data->>'adjusted_profit', ',', '')::numeric, 0),
            NULLIF(
              REPLACE(COALESCE(pr.raw_data->>'Price','0'), '$', '')::numeric
              - REPLACE(COALESCE(pr.raw_data->>'Actual Cost','0'), '$', '')::numeric,
            0),
            COALESCE((pr.raw_data->>'gross_profit')::numeric, (pr.raw_data->>'net_profit')::numeric, (pr.raw_data->>'Gross Profit')::numeric, (pr.raw_data->>'Net Profit')::numeric, 0)
          )
        ), 0) as gross_profit,
        CASE
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(
            COALESCE(
              NULLIF(REPLACE(pr.raw_data->>'gross_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Gross Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'grossprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'GrossProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'net_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Net Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'netprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'NetProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adj_profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Adj Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adjprofit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'AdjProfit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'Adjusted Profit', ',', '')::numeric, 0),
              NULLIF(REPLACE(pr.raw_data->>'adjusted_profit', ',', '')::numeric, 0),
              NULLIF(
                REPLACE(COALESCE(pr.raw_data->>'Price','0'), '$', '')::numeric
                - REPLACE(COALESCE(pr.raw_data->>'Actual Cost','0'), '$', '')::numeric,
              0),
              COALESCE((pr.raw_data->>'gross_profit')::numeric, (pr.raw_data->>'net_profit')::numeric, (pr.raw_data->>'Gross Profit')::numeric, (pr.raw_data->>'Net Profit')::numeric, 0)
            )
          ), 0) / COUNT(*)
          ELSE 0
        END as gp_per_rx,
        COUNT(DISTINCT o.opportunity_id) as opportunity_count,
        COALESCE(SUM(DISTINCT o.annual_margin_gain), 0) as opportunity_value
      FROM prescriptions pr
      LEFT JOIN opportunities o ON o.prescription_id = pr.prescription_id AND o.status = 'Not Submitted'
      WHERE pr.pharmacy_id = $1
        AND pr.dispensed_date >= NOW() - INTERVAL '365 days'
      GROUP BY COALESCE(pr.prescriber_name, 'Unknown')
      ORDER BY rx_count DESC
      LIMIT 50
    `, [pharmacyId]);

    return {
      pharmacy_wide: {
        total_rx_count: parseInt(pharmacyWide.rows[0].total_rx_count) || 0,
        total_gross_profit: parseFloat(pharmacyWide.rows[0].total_gross_profit) || 0,
        gp_per_rx: parseFloat(pharmacyWide.rows[0].gp_per_rx) || 0,
        opportunity_impact: oppImpact,
        projected_gp_per_rx: projectedGpPerRx,
      },
      by_bin: byBin.rows.map(r => ({
        bin: r.bin,
        rx_count: parseInt(r.rx_count) || 0,
        gross_profit: parseFloat(r.gross_profit) || 0,
        gp_per_rx: parseFloat(r.gp_per_rx) || 0,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        opportunity_value: parseFloat(r.opportunity_value) || 0,
      })),
      by_group: byGroup.rows.map(r => ({
        bin: r.bin,
        group: r.group,
        rx_count: parseInt(r.rx_count) || 0,
        gross_profit: parseFloat(r.gross_profit) || 0,
        gp_per_rx: parseFloat(r.gp_per_rx) || 0,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        opportunity_value: parseFloat(r.opportunity_value) || 0,
      })),
      by_prescriber: byPrescriber.rows.map(r => ({
        prescriber_name: r.prescriber_name,
        rx_count: parseInt(r.rx_count) || 0,
        gross_profit: parseFloat(r.gross_profit) || 0,
        gp_per_rx: parseFloat(r.gp_per_rx) || 0,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        opportunity_value: parseFloat(r.opportunity_value) || 0,
      })),
    };
    }, CACHE_10MIN);

    res.json(data);
  } catch (error) {
    logger.error('GP metrics error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to get GP metrics' });
  }
});

// Monthly activity report
router.get('/monthly', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { month, year } = req.query;

    console.log('Monthly report request:', { pharmacyId, month, year });

    const monthNum = parseInt(month) || (new Date().getMonth() + 1);
    const yearNum = parseInt(year) || new Date().getFullYear();

    // Start and end of month
    const startDate = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01`;
    const endDate = new Date(yearNum, monthNum, 0).toISOString().split('T')[0]; // Last day of month

    // CRITICAL: Monthly reports show ALL historical data - NEVER filter worked opportunities
    // Data quality filter only applies to the active opportunity queue, not historical reports

    // Overall stats for the month - use actioned_at for status changes
    const statsResult = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= $2 AND created_at <= $3) as total_opportunities,
        COUNT(*) FILTER (WHERE created_at >= $2 AND created_at <= $3) as new_opportunities,
        COUNT(*) FILTER (WHERE status IN ('Submitted', 'Pending', 'Approved', 'Completed') AND actioned_at >= $2 AND actioned_at <= $3) as submitted,
        COUNT(*) FILTER (WHERE status IN ('Approved', 'Completed') AND actioned_at >= $2 AND actioned_at <= $3) as captured,
        COUNT(*) FILTER (WHERE status = 'Completed' AND actioned_at >= $2 AND actioned_at <= $3) as completed,
        COUNT(*) FILTER (WHERE status = 'Approved' AND actioned_at >= $2 AND actioned_at <= $3) as approved,
        COUNT(*) FILTER (WHERE status IN ('Rejected', 'Declined', 'Denied') AND actioned_at >= $2 AND actioned_at <= $3) as rejected,
        COALESCE(SUM(potential_margin_gain) FILTER (WHERE created_at >= $2 AND created_at <= $3), 0) * 12 as total_value,
        COALESCE(SUM(potential_margin_gain) FILTER (WHERE status IN ('Approved', 'Completed') AND actioned_at >= $2 AND actioned_at <= $3), 0) * 12 as captured_value,
        COALESCE(SUM(potential_margin_gain) FILTER (WHERE status = 'Completed' AND actioned_at >= $2 AND actioned_at <= $3), 0) * 12 as completed_value,
        COALESCE(SUM(potential_margin_gain) FILTER (WHERE status = 'Approved' AND actioned_at >= $2 AND actioned_at <= $3), 0) * 12 as approved_value
      FROM opportunities
      WHERE pharmacy_id = $1
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);
    
    const stats = statsResult.rows[0];
    
    // Calculate rates
    // Submission rate: opportunities that were acted on / total
    const submissionRate = stats.total_opportunities > 0
      ? stats.submitted / stats.total_opportunities
      : 0;
    // Capture rate: (Approved + Completed) / all acted opportunities
    // "Acted" = anything not in 'Not Submitted' status
    const totalActed = parseInt(stats.submitted) + parseInt(stats.rejected);
    const captureRate = totalActed > 0
      ? stats.captured / totalActed
      : 0;
    
    // By status - show opportunities actioned in this month
    const byStatusResult = await db.query(`
      SELECT
        status,
        COUNT(*) as count,
        COALESCE(SUM(potential_margin_gain), 0) * 12 as value
      FROM opportunities
      WHERE pharmacy_id = $1
        AND actioned_at >= $2 AND actioned_at <= $3
        AND status != 'Not Submitted'
      GROUP BY status
      ORDER BY count DESC
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);
    
    // By type - show opportunities actioned in this month
    const byTypeResult = await db.query(`
      SELECT
        COALESCE(opportunity_type, 'Other') as type,
        COUNT(*) as count,
        COALESCE(SUM(potential_margin_gain), 0) * 12 as value,
        COUNT(*) FILTER (WHERE status IN ('Approved', 'Completed')) as captured
      FROM opportunities
      WHERE pharmacy_id = $1
        AND actioned_at >= $2 AND actioned_at <= $3
        AND status != 'Not Submitted'
      GROUP BY opportunity_type
      ORDER BY count DESC
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);
    
    // Daily activity - use actioned_at for when work was done
    const dailyResult = await db.query(`
      SELECT
        DATE(actioned_at) as date,
        COUNT(*) FILTER (WHERE status IN ('Submitted', 'Pending')) as submitted,
        COUNT(*) FILTER (WHERE status IN ('Approved', 'Completed')) as captured,
        COUNT(*) FILTER (WHERE status = 'Completed') as completed,
        COUNT(*) FILTER (WHERE status = 'Approved') as approved
      FROM opportunities
      WHERE pharmacy_id = $1
        AND actioned_at >= $2 AND actioned_at <= $3
        AND status != 'Not Submitted'
      GROUP BY DATE(actioned_at)
      ORDER BY date
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);

    // By BIN - show opportunities actioned in this month
    const byBinResult = await db.query(`
      SELECT
        COALESCE(pr.insurance_bin, 'Unknown') as bin,
        COUNT(DISTINCT o.opportunity_id) as count,
        COALESCE(SUM(o.potential_margin_gain), 0) * 12 as value,
        COUNT(DISTINCT o.opportunity_id) FILTER (WHERE o.status IN ('Approved', 'Completed')) as captured,
        COALESCE(SUM(o.potential_margin_gain) FILTER (WHERE o.status IN ('Approved', 'Completed')), 0) * 12 as captured_value
      FROM opportunities o
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.pharmacy_id = $1
        AND o.actioned_at >= $2 AND o.actioned_at <= $3
        AND o.status != 'Not Submitted'
      GROUP BY COALESCE(pr.insurance_bin, 'Unknown')
      ORDER BY count DESC
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);

    // Weekly breakdown by actioned date - NO data quality filter on historical reports
    const weeklyResult = await db.query(`
      SELECT
        DATE_TRUNC('week', actioned_at) as week_start,
        COUNT(*) as actioned_count,
        COALESCE(SUM(potential_margin_gain), 0) * 12 as actioned_value
      FROM opportunities
      WHERE pharmacy_id = $1
        AND actioned_at >= $2 AND actioned_at <= $3
        AND status IN ('Submitted', 'Approved', 'Completed')
      GROUP BY DATE_TRUNC('week', actioned_at)
      ORDER BY week_start
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);

    // Staff performance - who completed/actioned opportunities THIS MONTH
    const staffResult = await db.query(`
      SELECT
        u.user_id,
        u.first_name,
        u.last_name,
        u.role,
        COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending', 'Approved', 'Completed')) as actioned_count,
        COUNT(*) FILTER (WHERE o.status IN ('Approved', 'Completed')) as captured_count,
        COUNT(*) FILTER (WHERE o.status = 'Approved') as approved_count,
        COALESCE(SUM(o.potential_margin_gain) FILTER (WHERE o.status = 'Approved'), 0) * 12 as approved_value,
        COUNT(*) FILTER (WHERE o.status = 'Completed') as completed_count,
        COALESCE(SUM(o.potential_margin_gain) FILTER (WHERE o.status = 'Completed'), 0) * 12 as completed_value,
        COALESCE(SUM(o.potential_margin_gain) FILTER (WHERE o.status IN ('Approved', 'Completed')), 0) * 12 as captured_value,
        COALESCE(AVG(o.potential_margin_gain) FILTER (WHERE o.status IN ('Approved', 'Completed')), 0) * 12 as avg_value_per_capture
      FROM opportunities o
      JOIN users u ON u.user_id = o.actioned_by
      WHERE o.pharmacy_id = $1
        AND o.actioned_by IS NOT NULL
        AND o.actioned_at >= $2 AND o.actioned_at <= $3
      GROUP BY u.user_id, u.first_name, u.last_name, u.role
      ORDER BY completed_count DESC, captured_value DESC
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);

    res.json({
      month: monthNum,
      year: yearNum,
      total_opportunities: parseInt(stats.total_opportunities) || 0,
      new_opportunities: parseInt(stats.new_opportunities) || 0,
      submitted: parseInt(stats.submitted) || 0,
      captured: parseInt(stats.captured) || 0,
      completed: parseInt(stats.completed) || 0,
      approved: parseInt(stats.approved) || 0,
      rejected: parseInt(stats.rejected) || 0,
      total_value: parseFloat(stats.total_value) || 0,
      captured_value: parseFloat(stats.captured_value) || 0,
      completed_value: parseFloat(stats.completed_value) || 0,
      approved_value: parseFloat(stats.approved_value) || 0,
      submission_rate: submissionRate,
      capture_rate: captureRate,
      by_status: byStatusResult.rows.map(r => ({
        status: r.status,
        count: parseInt(r.count) || 0,
        value: parseFloat(r.value) || 0,
      })),
      by_type: byTypeResult.rows.map(r => ({
        type: r.type,
        count: parseInt(r.count) || 0,
        value: parseFloat(r.value) || 0,
        captured: parseInt(r.captured) || 0,
      })),
      daily_activity: dailyResult.rows.map(r => ({
        date: r.date,
        submitted: parseInt(r.submitted) || 0,
        captured: parseInt(r.captured) || 0,
        completed: parseInt(r.completed) || 0,
        approved: parseInt(r.approved) || 0,
      })),
      by_bin: byBinResult.rows.map(r => ({
        bin: r.bin,
        count: parseInt(r.count) || 0,
        value: parseFloat(r.value) || 0,
        captured: parseInt(r.captured) || 0,
        captured_value: parseFloat(r.captured_value) || 0,
      })),
      weekly_activity: weeklyResult.rows.map(r => ({
        week_start: r.week_start,
        actioned_count: parseInt(r.actioned_count) || 0,
        actioned_value: parseFloat(r.actioned_value) || 0,
      })),
      staff_performance: staffResult.rows.map(r => ({
        user_id: r.user_id,
        name: `${r.first_name} ${r.last_name}`,
        role: r.role,
        actioned_count: parseInt(r.actioned_count) || 0,
        captured_count: parseInt(r.captured_count) || 0,
        approved_count: parseInt(r.approved_count) || 0,
        approved_value: parseFloat(r.approved_value) || 0,
        completed_count: parseInt(r.completed_count) || 0,
        completed_value: parseFloat(r.completed_value) || 0,
        captured_value: parseFloat(r.captured_value) || 0,
        avg_value_per_capture: parseFloat(r.avg_value_per_capture) || 0,
      })),
    });
  } catch (error) {
    console.error('Monthly report error:', error.message);
    console.error('Monthly report stack:', error.stack);
    logger.error('Monthly report error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to get monthly report', details: error.message });
  }
});

// Export monthly report as CSV
router.get('/monthly/export', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { month, year, format = 'csv' } = req.query;

    const monthNum = parseInt(month) || (new Date().getMonth() + 1);
    const yearNum = parseInt(year) || new Date().getFullYear();

    const startDate = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01`;
    const endDate = new Date(yearNum, monthNum, 0).toISOString().split('T')[0];

    // Get all opportunities for the month - NO data quality filter on exports (historical data)
    const result = await db.query(`
      SELECT
        o.opportunity_id,
        p.first_name as patient_first_name,
        p.last_name as patient_last_name,
        o.opportunity_type,
        o.status,
        o.annual_margin_gain,
        o.created_at,
        o.updated_at,
        o.notes
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      WHERE o.pharmacy_id = $1
        AND (o.created_at >= $2 AND o.created_at <= $3 OR o.updated_at >= $2 AND o.updated_at <= $3)
      ORDER BY o.updated_at DESC
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);

    if (format === 'csv') {
      const headers = ['Opportunity ID', 'Patient', 'Type', 'Status', 'Annual Value', 'Created', 'Updated', 'Notes'];
      const rows = result.rows.map(r => [
        r.opportunity_id,
        formatPatientName(r.patient_first_name, r.patient_last_name),
        r.opportunity_type || 'Other',
        r.status,
        r.annual_margin_gain || 0,
        r.created_at?.toISOString().split('T')[0] || '',
        r.updated_at?.toISOString().split('T')[0] || '',
        (r.notes || '').replace(/,/g, ';').replace(/\n/g, ' '),
      ]);
      
      const csv = [
        headers.join(','),
        ...rows.map(row => row.join(','))
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=therxos-report-${monthNum}-${yearNum}.csv`);
      res.send(csv);
    } else {
      // Format patient names for JSON response
      const formattedOpportunities = result.rows.map(r => ({
        ...r,
        patient_name: formatPatientName(r.patient_first_name, r.patient_last_name)
      }));
      res.json({ opportunities: formattedOpportunities });
    }
  } catch (error) {
    logger.error('Export error', { error: error.message });
    res.status(500).json({ error: 'Failed to export report' });
  }
});

// Audit flags for pharmacy
router.get('/audit-flags', authenticateToken, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ flags: [], total: 0, message: 'Audit rules temporarily disabled' });
  try {
    const { status, severity, limit = 100, offset = 0 } = req.query;

    // Super admins can specify a pharmacyId, otherwise use the user's pharmacy
    let pharmacyId = req.user.pharmacyId;
    if (req.user.role === 'super_admin' && req.query.pharmacyId) {
      pharmacyId = req.query.pharmacyId;
    }

    console.log('Fetching audit flags for pharmacy:', pharmacyId, 'user role:', req.user.role);

    let query = `
      SELECT
        af.*,
        p.first_name as patient_first_name,
        p.last_name as patient_last_name,
        ar.rule_name,
        ar.rule_description
      FROM audit_flags af
      LEFT JOIN patients p ON p.patient_id = af.patient_id
      LEFT JOIN audit_rules ar ON ar.rule_id = af.rule_id
      WHERE af.pharmacy_id = $1
    `;
    const params = [pharmacyId];
    let paramIndex = 2;

    if (status) {
      query += ` AND af.status = $${paramIndex++}`;
      params.push(status);
    }
    if (severity) {
      query += ` AND af.severity = $${paramIndex++}`;
      params.push(severity);
    }

    query += ` ORDER BY af.flagged_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get counts by status
    const countsResult = await db.query(`
      SELECT
        status,
        COUNT(*) as count
      FROM audit_flags
      WHERE pharmacy_id = $1
      GROUP BY status
    `, [pharmacyId]);

    // Get counts by severity
    const severityResult = await db.query(`
      SELECT
        severity,
        COUNT(*) as count
      FROM audit_flags
      WHERE pharmacy_id = $1
      GROUP BY severity
    `, [pharmacyId]);

    // Format patient names for display
    const formattedFlags = result.rows.map(f => ({
      ...f,
      patient_name: formatPatientName(f.patient_first_name, f.patient_last_name)
    }));

    res.json({
      flags: formattedFlags,
      total: result.rows.length,
      counts: {
        byStatus: countsResult.rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count) }), {}),
        bySeverity: severityResult.rows.reduce((acc, r) => ({ ...acc, [r.severity]: parseInt(r.count) }), {})
      }
    });
  } catch (error) {
    logger.error('Fetch audit flags error', { error: error.message, stack: error.stack });
    // Return more details in dev/debug scenarios
    res.status(500).json({
      error: 'Failed to fetch audit flags',
      details: error.message,
      pharmacyId: req.user?.pharmacyId
    });
  }
});

// Prescriber opportunity analytics
router.get('/prescriber-stats', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { limit = 50, status = 'all' } = req.query;
    const cacheKey = `pharmacy:${pharmacyId}:prescriber-stats:${status}:${limit}`;

    const data = await cached(cacheKey, async () => {
    // Top prescribers by opportunity value
    let statusFilter = '';
    if (status !== 'all') {
      statusFilter = `AND o.status = '${status}'`;
    }

    const topByValue = await db.query(`
      SELECT
        COALESCE(o.prescriber_name, 'Unknown') as prescriber_name,
        COUNT(*) as opportunity_count,
        COUNT(DISTINCT o.patient_id) as patient_count,
        COALESCE(SUM(o.potential_margin_gain), 0) as monthly_potential,
        COALESCE(SUM(o.annual_margin_gain), 0) as annual_potential,
        COALESCE(AVG(o.potential_margin_gain), 0) as avg_opportunity_value,
        COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending', 'Approved', 'Completed')) as actioned_count,
        COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending', 'Approved', 'Completed') AND o.actioned_at >= NOW() - INTERVAL '7 days') as actioned_last_7_days,
        CASE
          WHEN COUNT(*) > 0
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending', 'Approved', 'Completed')) / COUNT(*), 1)
          ELSE 0
        END as action_rate
      FROM opportunities o
      WHERE o.pharmacy_id = $1 ${statusFilter}
      GROUP BY COALESCE(o.prescriber_name, 'Unknown')
      ORDER BY SUM(o.annual_margin_gain) DESC
      LIMIT $2
    `, [pharmacyId, parseInt(limit)]);

    // Top prescribers by opportunity count
    const topByCount = await db.query(`
      SELECT
        COALESCE(o.prescriber_name, 'Unknown') as prescriber_name,
        COUNT(*) as opportunity_count,
        COALESCE(SUM(o.annual_margin_gain), 0) as annual_potential
      FROM opportunities o
      WHERE o.pharmacy_id = $1 ${statusFilter}
      GROUP BY COALESCE(o.prescriber_name, 'Unknown')
      ORDER BY COUNT(*) DESC
      LIMIT $2
    `, [pharmacyId, parseInt(limit)]);

    // Top prescribers by action rate (min 5 opportunities)
    const topByActionRate = await db.query(`
      SELECT
        COALESCE(o.prescriber_name, 'Unknown') as prescriber_name,
        COUNT(*) as opportunity_count,
        COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending', 'Approved', 'Completed')) as actioned_count,
        ROUND(100.0 * COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending', 'Approved', 'Completed')) / COUNT(*), 1) as action_rate,
        COALESCE(SUM(o.annual_margin_gain), 0) as annual_potential
      FROM opportunities o
      WHERE o.pharmacy_id = $1
      GROUP BY COALESCE(o.prescriber_name, 'Unknown')
      HAVING COUNT(*) >= 5
      ORDER BY ROUND(100.0 * COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending', 'Approved', 'Completed')) / COUNT(*), 1) DESC
      LIMIT $2
    `, [pharmacyId, parseInt(limit)]);

    // Opportunity type breakdown by prescriber (top 10 prescribers)
    const byTypeResult = await db.query(`
      WITH top_prescribers AS (
        SELECT prescriber_name
        FROM opportunities
        WHERE pharmacy_id = $1 AND prescriber_name IS NOT NULL
        GROUP BY prescriber_name
        ORDER BY SUM(annual_margin_gain) DESC
        LIMIT 10
      )
      SELECT
        o.prescriber_name,
        o.opportunity_type,
        COUNT(*) as count,
        COALESCE(SUM(o.annual_margin_gain), 0) as annual_value
      FROM opportunities o
      WHERE o.pharmacy_id = $1
        AND o.prescriber_name IN (SELECT prescriber_name FROM top_prescribers)
      GROUP BY o.prescriber_name, o.opportunity_type
      ORDER BY o.prescriber_name, SUM(o.annual_margin_gain) DESC
    `, [pharmacyId]);

    // Group by prescriber for the type breakdown
    const byPrescriberType = {};
    for (const row of byTypeResult.rows) {
      if (!byPrescriberType[row.prescriber_name]) {
        byPrescriberType[row.prescriber_name] = [];
      }
      byPrescriberType[row.prescriber_name].push({
        type: row.opportunity_type,
        count: parseInt(row.count),
        annual_value: parseFloat(row.annual_value)
      });
    }

    // Summary stats
    const summary = await db.query(`
      SELECT
        COUNT(DISTINCT prescriber_name) as total_prescribers,
        COUNT(*) as total_opportunities,
        COALESCE(SUM(annual_margin_gain), 0) as total_annual_value,
        COUNT(DISTINCT prescriber_name) FILTER (WHERE prescriber_name IS NOT NULL AND prescriber_name != 'Unknown') as known_prescribers
      FROM opportunities
      WHERE pharmacy_id = $1 ${statusFilter}
    `, [pharmacyId]);

    return {
      summary: {
        total_prescribers: parseInt(summary.rows[0].total_prescribers) || 0,
        known_prescribers: parseInt(summary.rows[0].known_prescribers) || 0,
        total_opportunities: parseInt(summary.rows[0].total_opportunities) || 0,
        total_annual_value: parseFloat(summary.rows[0].total_annual_value) || 0
      },
      top_by_value: topByValue.rows.map(r => ({
        prescriber_name: r.prescriber_name,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        patient_count: parseInt(r.patient_count) || 0,
        monthly_potential: parseFloat(r.monthly_potential) || 0,
        annual_potential: parseFloat(r.annual_potential) || 0,
        avg_opportunity_value: parseFloat(r.avg_opportunity_value) || 0,
        actioned_count: parseInt(r.actioned_count) || 0,
        actioned_last_7_days: parseInt(r.actioned_last_7_days) || 0,
        action_rate: parseFloat(r.action_rate) || 0
      })),
      top_by_count: topByCount.rows.map(r => ({
        prescriber_name: r.prescriber_name,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        annual_potential: parseFloat(r.annual_potential) || 0
      })),
      top_by_action_rate: topByActionRate.rows.map(r => ({
        prescriber_name: r.prescriber_name,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        actioned_count: parseInt(r.actioned_count) || 0,
        action_rate: parseFloat(r.action_rate) || 0,
        annual_potential: parseFloat(r.annual_potential) || 0
      })),
      by_prescriber_type: byPrescriberType
    };
    }, CACHE_5MIN);

    res.json(data);
  } catch (error) {
    logger.error('Prescriber stats error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to get prescriber stats' });
  }
});

// Recommended drug performance analytics
router.get('/recommended-drug-stats', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { limit = 30 } = req.query;
    const cacheKey = `pharmacy:${pharmacyId}:drug-stats:${limit}`;

    const data = await cached(cacheKey, async () => {
    // Top recommended drugs by opportunity value
    const topDrugs = await db.query(`
      SELECT
        COALESCE(o.recommended_drug, o.recommended_drug_name, 'Unknown') as recommended_drug,
        COUNT(*) as opportunity_count,
        COUNT(DISTINCT o.patient_id) as patient_count,
        COALESCE(SUM(o.potential_margin_gain), 0) as monthly_potential,
        COALESCE(SUM(o.annual_margin_gain), 0) as annual_potential,
        COALESCE(AVG(o.potential_margin_gain), 0) as avg_gp_per_fill,
        COUNT(*) FILTER (WHERE o.status = 'Not Submitted') as pending,
        COUNT(*) FILTER (WHERE o.status IN ('Submitted', 'Pending')) as in_progress,
        COUNT(*) FILTER (WHERE o.status IN ('Approved', 'Completed')) as captured
      FROM opportunities o
      WHERE o.pharmacy_id = $1
      GROUP BY COALESCE(o.recommended_drug, o.recommended_drug_name, 'Unknown')
      ORDER BY SUM(o.annual_margin_gain) DESC
      LIMIT $2
    `, [pharmacyId, parseInt(limit)]);

    // Current drugs being targeted
    const topCurrentDrugs = await db.query(`
      SELECT
        o.current_drug_name,
        COALESCE(o.recommended_drug, o.recommended_drug_name) as recommended_drug,
        COUNT(*) as opportunity_count,
        COALESCE(SUM(o.annual_margin_gain), 0) as annual_potential
      FROM opportunities o
      WHERE o.pharmacy_id = $1 AND o.current_drug_name IS NOT NULL
      GROUP BY o.current_drug_name, COALESCE(o.recommended_drug, o.recommended_drug_name)
      ORDER BY SUM(o.annual_margin_gain) DESC
      LIMIT $2
    `, [pharmacyId, parseInt(limit)]);

    return {
      top_recommended_drugs: topDrugs.rows.map(r => ({
        recommended_drug: r.recommended_drug,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        patient_count: parseInt(r.patient_count) || 0,
        monthly_potential: parseFloat(r.monthly_potential) || 0,
        annual_potential: parseFloat(r.annual_potential) || 0,
        avg_gp_per_fill: parseFloat(r.avg_gp_per_fill) || 0,
        pending: parseInt(r.pending) || 0,
        in_progress: parseInt(r.in_progress) || 0,
        captured: parseInt(r.captured) || 0
      })),
      top_current_drugs: topCurrentDrugs.rows.map(r => ({
        current_drug: r.current_drug_name,
        recommended_drug: r.recommended_drug,
        opportunity_count: parseInt(r.opportunity_count) || 0,
        annual_potential: parseFloat(r.annual_potential) || 0
      }))
    };
    }, CACHE_5MIN);

    res.json(data);
  } catch (error) {
    logger.error('Recommended drug stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get recommended drug stats' });
  }
});

// Update audit flag status
router.put('/audit-flags/:flagId', authenticateToken, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
  try {
    const { flagId } = req.params;
    const { status, resolution_notes } = req.body;
    const pharmacyId = req.user.pharmacyId;

    const result = await db.query(`
      UPDATE audit_flags
      SET status = $1,
          resolution_notes = $2,
          reviewed_by = $3,
          reviewed_at = NOW()
      WHERE flag_id = $4 AND pharmacy_id = $5
      RETURNING *
    `, [status, resolution_notes, req.user.userId, flagId, pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit flag not found' });
    }

    res.json({ flag: result.rows[0] });
  } catch (error) {
    logger.error('Update audit flag error', { error: error.message });
    res.status(500).json({ error: 'Failed to update audit flag' });
  }
});

// ===========================================
// GLP-1 AUDIT ENDPOINTS
// ===========================================

// GET /api/analytics/glp1/summary - GLP-1 audit summary
router.get('/glp1/summary', authenticateToken, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ totalRx: 0, uniquePatients: 0, totalCost: 0, avgCost: 0, auditFlags: { open: 0, resolved: 0, byType: {} }, negativeMargin: { count: 0, totalLoss: 0 } });
  try {
    const pharmacyId = req.user.pharmacyId;
    const { days = 30 } = req.query;

    // Get GLP-1 prescription counts
    const rxStats = await db.query(`
      SELECT
        COUNT(*) as total_glp1_rx,
        COUNT(DISTINCT patient_id) as glp1_patients,
        SUM(CASE WHEN COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0) < 0 THEN 1 ELSE 0 END) as negative_margin_count,
        SUM(CASE WHEN COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0) < 0
            THEN COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0) ELSE 0 END) as total_loss
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND drug_name ~* 'OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE|EXENATIDE'
        AND dispensed_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
    `, [pharmacyId, days]);

    // Get open audit flags by type
    const flagStats = await db.query(`
      SELECT
        rule_type,
        severity,
        COUNT(*) as count
      FROM audit_flags
      WHERE pharmacy_id = $1
        AND rule_type LIKE '%glp1%' OR rule_type IN ('quantity_mismatch', 'days_supply_mismatch', 'early_refill', 'negative_profit', 'duplicate_therapy', 'compounding_risk', 'indication_mismatch', 'high_quantity')
        AND status = 'open'
      GROUP BY rule_type, severity
      ORDER BY severity DESC, count DESC
    `, [pharmacyId]);

    // Get top negative margin BINs
    const negativeBins = await glp1Scanner.getGLP1NegativeMarginByBIN(pharmacyId, parseInt(days));

    res.json({
      period: `${days} days`,
      prescriptions: rxStats.rows[0],
      openFlags: flagStats.rows,
      negativeMarginBINs: negativeBins.slice(0, 10)
    });
  } catch (error) {
    logger.error('GLP-1 summary error', { error: error.message });
    res.status(500).json({ error: 'Failed to get GLP-1 summary' });
  }
});

// GET /api/analytics/glp1/audit-flags - GLP-1 specific audit flags
router.get('/glp1/audit-flags', authenticateToken, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ flags: [], total: 0, message: 'Audit rules temporarily disabled' });
  try {
    const pharmacyId = req.user.pharmacyId;
    const { status = 'open', severity, limit = 100, offset = 0 } = req.query;

    let whereClause = 'WHERE af.pharmacy_id = $1';
    const params = [pharmacyId];
    let paramIndex = 2;

    if (status !== 'all') {
      whereClause += ` AND af.status = $${paramIndex++}`;
      params.push(status);
    }

    if (severity) {
      whereClause += ` AND af.severity = $${paramIndex++}`;
      params.push(severity);
    }

    // Only GLP-1 related flags
    whereClause += ` AND (af.drug_name ~* 'OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE|EXENATIDE')`;

    const result = await db.query(`
      SELECT
        af.flag_id,
        af.rule_type,
        af.severity,
        af.drug_name,
        af.ndc,
        af.dispensed_quantity,
        af.days_supply,
        af.gross_profit,
        af.violation_message,
        af.expected_value,
        af.actual_value,
        af.status,
        af.dispensed_date,
        af.flagged_at,
        p.first_name as patient_first,
        p.last_name as patient_last,
        ar.rule_name,
        ar.audit_risk_score
      FROM audit_flags af
      LEFT JOIN patients p ON af.patient_id = p.patient_id
      LEFT JOIN audit_rules ar ON af.rule_id = ar.rule_id
      ${whereClause}
      ORDER BY
        CASE af.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
        af.flagged_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `, [...params, parseInt(limit), parseInt(offset)]);

    const countResult = await db.query(`
      SELECT COUNT(*) as total
      FROM audit_flags af
      ${whereClause}
    `, params);

    res.json({
      flags: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    logger.error('GLP-1 audit flags error', { error: error.message });
    res.status(500).json({ error: 'Failed to get GLP-1 audit flags' });
  }
});

// POST /api/analytics/glp1/scan - Run GLP-1 audit scan
router.post('/glp1/scan', authenticateToken, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled', results: {} });
  try {
    const pharmacyId = req.user.pharmacyId;
    const { lookbackDays = 30, createFlags = true } = req.body;

    logger.info('Starting GLP-1 audit scan', { pharmacyId, lookbackDays });

    const results = await glp1Scanner.runGLP1AuditScan(pharmacyId, {
      lookbackDays: parseInt(lookbackDays),
      createFlags
    });

    // Summarize results
    const summary = {
      prescriptionsScanned: results.prescriptionsScanned,
      flagsCreated: results.flagsCreated,
      anomalies: {
        quantity: results.anomalies.quantity.length,
        daysSupply: results.anomalies.daysSupply.length,
        earlyRefill: results.anomalies.earlyRefill.length,
        negativeMargin: results.anomalies.negativeMargin.length,
        duplicateTherapy: results.anomalies.duplicateTherapy.length,
        compounding: results.anomalies.compounding.length,
        dawCode: results.anomalies.dawCode.length,
        indicationMismatch: results.anomalies.indicationMismatch.length,
        highQuantity: results.anomalies.highQuantity.length
      },
      totalAnomalies: Object.values(results.anomalies).reduce((sum, arr) => sum + arr.length, 0)
    };

    res.json({ success: true, summary });
  } catch (error) {
    logger.error('GLP-1 audit scan error', { error: error.message });
    res.status(500).json({ error: 'Failed to run GLP-1 audit scan' });
  }
});

// GET /api/analytics/glp1/negative-margin - Negative margin claims by BIN
router.get('/glp1/negative-margin', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { days = 90 } = req.query;

    const results = await glp1Scanner.getGLP1NegativeMarginByBIN(pharmacyId, parseInt(days));

    res.json({
      period: `${days} days`,
      bins: results
    });
  } catch (error) {
    logger.error('GLP-1 negative margin error', { error: error.message });
    res.status(500).json({ error: 'Failed to get negative margin data' });
  }
});

// GET /api/analytics/glp1/duplicate-therapy - Patients on multiple GLP-1s
router.get('/glp1/duplicate-therapy', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { days = 90 } = req.query;

    const result = await db.query(`
      WITH patient_glp1 AS (
        SELECT
          rx.patient_id,
          p.first_name,
          p.last_name,
          ARRAY_AGG(DISTINCT
            CASE
              WHEN rx.drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS' THEN 'SEMAGLUTIDE'
              WHEN rx.drug_name ~* 'MOUNJARO|ZEPBOUND' THEN 'TIRZEPATIDE'
              WHEN rx.drug_name ~* 'VICTOZA|SAXENDA' THEN 'LIRAGLUTIDE'
              WHEN rx.drug_name ~* 'TRULICITY' THEN 'DULAGLUTIDE'
              WHEN rx.drug_name ~* 'BYETTA|BYDUREON' THEN 'EXENATIDE'
              ELSE 'OTHER'
            END
          ) as glp1_classes,
          ARRAY_AGG(DISTINCT rx.drug_name) as drugs,
          MAX(rx.dispensed_date) as last_fill
        FROM prescriptions rx
        LEFT JOIN patients p ON rx.patient_id = p.patient_id
        WHERE rx.pharmacy_id = $1
          AND rx.drug_name ~* 'OZEMPIC|WEGOVY|MOUNJARO|ZEPBOUND|TRULICITY|VICTOZA|SAXENDA|RYBELSUS|BYETTA|BYDUREON|SEMAGLUTIDE|TIRZEPATIDE|LIRAGLUTIDE|DULAGLUTIDE|EXENATIDE'
          AND rx.dispensed_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
        GROUP BY rx.patient_id, p.first_name, p.last_name
        HAVING COUNT(DISTINCT
          CASE
            WHEN rx.drug_name ~* 'OZEMPIC|WEGOVY|RYBELSUS' THEN 'SEMAGLUTIDE'
            WHEN rx.drug_name ~* 'MOUNJARO|ZEPBOUND' THEN 'TIRZEPATIDE'
            WHEN rx.drug_name ~* 'VICTOZA|SAXENDA' THEN 'LIRAGLUTIDE'
            WHEN rx.drug_name ~* 'TRULICITY' THEN 'DULAGLUTIDE'
            WHEN rx.drug_name ~* 'BYETTA|BYDUREON' THEN 'EXENATIDE'
            ELSE 'OTHER'
          END
        ) > 1
      )
      SELECT * FROM patient_glp1
      ORDER BY last_fill DESC
    `, [pharmacyId, days]);

    res.json({
      period: `${days} days`,
      patients: result.rows
    });
  } catch (error) {
    logger.error('GLP-1 duplicate therapy error', { error: error.message });
    res.status(500).json({ error: 'Failed to get duplicate therapy data' });
  }
});

// GET /api/analytics/fax-stats - Fax statistics for reports tab
router.get('/fax-stats', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }

    const days = parseInt(req.query.days) || 30;
    const interval = `${days} days`;

    const [summary, byType, byUser, daily] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) as total_sent,
          COUNT(*) FILTER (WHERE fax_status = 'successful') as delivered,
          COUNT(*) FILTER (WHERE fax_status = 'failed') as failed,
          COUNT(*) FILTER (WHERE fax_status IN ('queued', 'sending', 'accepted', 'in_progress')) as pending,
          COALESCE(SUM(page_count), 0) as total_pages,
          CASE WHEN COUNT(*) > 0
            THEN ROUND(100.0 * COUNT(*) FILTER (WHERE fax_status = 'successful') / COUNT(*), 1)
            ELSE 0 END as delivery_rate
        FROM fax_log
        WHERE pharmacy_id = $1 AND sent_at >= NOW() - INTERVAL '${interval}'
      `, [pharmacyId]),

      db.query(`
        SELECT trigger_type, COUNT(*) as count,
          COUNT(*) FILTER (WHERE fax_status = 'successful') as delivered
        FROM fax_log
        WHERE pharmacy_id = $1 AND sent_at >= NOW() - INTERVAL '${interval}'
        GROUP BY trigger_type ORDER BY count DESC
      `, [pharmacyId]),

      db.query(`
        SELECT u.first_name, u.last_name,
          COUNT(*) as faxes_sent,
          COUNT(*) FILTER (WHERE fl.fax_status = 'successful') as delivered
        FROM fax_log fl
        JOIN users u ON u.user_id = fl.sent_by
        WHERE fl.pharmacy_id = $1 AND fl.sent_at >= NOW() - INTERVAL '${interval}'
        GROUP BY u.user_id, u.first_name, u.last_name
        ORDER BY faxes_sent DESC
      `, [pharmacyId]),

      db.query(`
        SELECT DATE(sent_at) as date,
          COUNT(*) as sent,
          COUNT(*) FILTER (WHERE fax_status = 'successful') as delivered
        FROM fax_log
        WHERE pharmacy_id = $1 AND sent_at >= NOW() - INTERVAL '${interval}'
        GROUP BY DATE(sent_at) ORDER BY date ASC
      `, [pharmacyId])
    ]);

    res.json({
      period: `${days} days`,
      summary: summary.rows[0],
      byType: byType.rows,
      byUser: byUser.rows,
      daily: daily.rows
    });
  } catch (error) {
    logger.error('Fax stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get fax statistics' });
  }
});

export default router;
