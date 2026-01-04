// Analytics routes for TheRxOS V2
import express from 'express';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Dashboard overview stats
router.get('/dashboard', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { period = '30' } = req.query;
    const days = parseInt(period);

    const overview = await db.query(`
      SELECT
        -- Opportunity stats
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Not Submitted') as pending_opportunities,
        (SELECT COALESCE(SUM(potential_margin_gain), 0) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Not Submitted') as pending_margin,
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status = 'actioned' AND actioned_at >= NOW() - INTERVAL '${days} days') as actioned_count,
        (SELECT COALESCE(SUM(actual_margin_realized), 0) FROM opportunities WHERE pharmacy_id = $1 AND status = 'actioned' AND actioned_at >= NOW() - INTERVAL '${days} days') as realized_margin,
        
        -- Prescription stats
        (SELECT COUNT(*) FROM prescriptions WHERE pharmacy_id = $1 AND dispensed_date >= NOW() - INTERVAL '${days} days') as rx_count,
        (SELECT COUNT(DISTINCT patient_id) FROM prescriptions WHERE pharmacy_id = $1 AND dispensed_date >= NOW() - INTERVAL '${days} days') as active_patients,
        
        -- Patient stats
        (SELECT COUNT(*) FROM patients WHERE pharmacy_id = $1) as total_patients,
        (SELECT COUNT(*) FROM patients WHERE pharmacy_id = $1 AND med_sync_enrolled = true) as med_sync_patients,
        
        -- Action rate
        (SELECT 
          CASE WHEN COUNT(*) > 0 
          THEN ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'actioned') / COUNT(*), 1)
          ELSE 0 END
        FROM opportunities 
        WHERE pharmacy_id = $1 AND created_at >= NOW() - INTERVAL '${days} days') as action_rate
    `, [pharmacyId]);

    res.json(overview.rows[0]);
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

    const result = await db.query(`
      SELECT 
        opportunity_type,
        COUNT(*) as count,
        COALESCE(SUM(potential_margin_gain), 0) as total_margin,
        COALESCE(AVG(potential_margin_gain), 0) as avg_margin,
        COUNT(DISTINCT patient_id) as patient_count
      FROM opportunities
      WHERE pharmacy_id = $1 AND status = $2
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
        p.chronic_conditions,
        COUNT(o.opportunity_id) as opportunity_count,
        COALESCE(SUM(o.potential_margin_gain), 0) as total_margin,
        (SELECT MAX(dispensed_date) FROM prescriptions WHERE patient_id = p.patient_id) as last_visit
      FROM patients p
      JOIN opportunities o ON o.patient_id = p.patient_id AND o.status = 'Not Submitted'
      WHERE p.pharmacy_id = $1
      GROUP BY p.patient_id, p.patient_hash, p.chronic_conditions
      ORDER BY total_margin DESC
      LIMIT $2
    `, [pharmacyId, parseInt(limit)]);

    res.json(result.rows);
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

    // Pharmacy-wide GP/Rx
    const pharmacyWide = await db.query(`
      SELECT
        COUNT(*) as total_rx_count,
        COALESCE(SUM(insurance_pay + patient_pay), 0) as total_gross_profit,
        CASE 
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(insurance_pay + patient_pay), 0) / COUNT(*)
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
        COALESCE(SUM(pr.insurance_pay + pr.patient_pay), 0) as gross_profit,
        CASE 
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(pr.insurance_pay + pr.patient_pay), 0) / COUNT(*)
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
        COALESCE(SUM(pr.insurance_pay + pr.patient_pay), 0) as gross_profit,
        CASE 
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(pr.insurance_pay + pr.patient_pay), 0) / COUNT(*)
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
        COALESCE(SUM(pr.insurance_pay + pr.patient_pay), 0) as gross_profit,
        CASE 
          WHEN COUNT(*) > 0 THEN COALESCE(SUM(pr.insurance_pay + pr.patient_pay), 0) / COUNT(*)
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

    res.json({
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
    });
  } catch (error) {
    logger.error('GP metrics error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to get GP metrics' });
  }
});

export default router;
