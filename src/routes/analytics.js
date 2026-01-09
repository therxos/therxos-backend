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

// Monthly activity report
router.get('/monthly', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { month, year } = req.query;
    
    const monthNum = parseInt(month) || (new Date().getMonth() + 1);
    const yearNum = parseInt(year) || new Date().getFullYear();
    
    // Start and end of month
    const startDate = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01`;
    const endDate = new Date(yearNum, monthNum, 0).toISOString().split('T')[0]; // Last day of month
    
    // Overall stats for the month
    const statsResult = await db.query(`
      SELECT
        COUNT(*) as total_opportunities,
        COUNT(*) FILTER (WHERE created_at >= $2 AND created_at <= $3) as new_opportunities,
        COUNT(*) FILTER (WHERE status IN ('Submitted', 'Pending', 'Approved', 'Completed') AND updated_at >= $2 AND updated_at <= $3) as submitted,
        COUNT(*) FILTER (WHERE status IN ('Approved', 'Completed', 'Captured') AND updated_at >= $2 AND updated_at <= $3) as captured,
        COUNT(*) FILTER (WHERE status IN ('Rejected', 'Declined') AND updated_at >= $2 AND updated_at <= $3) as rejected,
        COALESCE(SUM(annual_margin_gain), 0) as total_value,
        COALESCE(SUM(annual_margin_gain) FILTER (WHERE status IN ('Approved', 'Completed', 'Captured')), 0) as captured_value
      FROM opportunities
      WHERE pharmacy_id = $1
        AND (created_at >= $2 AND created_at <= $3 OR updated_at >= $2 AND updated_at <= $3)
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);
    
    const stats = statsResult.rows[0];
    
    // Calculate rates
    const submissionRate = stats.total_opportunities > 0 
      ? stats.submitted / stats.total_opportunities 
      : 0;
    const captureRate = stats.submitted > 0 
      ? stats.captured / stats.submitted 
      : 0;
    
    // By status
    const byStatusResult = await db.query(`
      SELECT 
        status,
        COUNT(*) as count,
        COALESCE(SUM(annual_margin_gain), 0) as value
      FROM opportunities
      WHERE pharmacy_id = $1
        AND (created_at >= $2 AND created_at <= $3 OR updated_at >= $2 AND updated_at <= $3)
      GROUP BY status
      ORDER BY count DESC
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);
    
    // By type
    const byTypeResult = await db.query(`
      SELECT 
        COALESCE(trigger_type, 'Other') as type,
        COUNT(*) as count,
        COALESCE(SUM(annual_margin_gain), 0) as value,
        COUNT(*) FILTER (WHERE status IN ('Approved', 'Completed', 'Captured')) as captured
      FROM opportunities
      WHERE pharmacy_id = $1
        AND (created_at >= $2 AND created_at <= $3 OR updated_at >= $2 AND updated_at <= $3)
      GROUP BY trigger_type
      ORDER BY count DESC
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);
    
    // Daily activity
    const dailyResult = await db.query(`
      SELECT 
        DATE(updated_at) as date,
        COUNT(*) FILTER (WHERE status IN ('Submitted', 'Pending')) as submitted,
        COUNT(*) FILTER (WHERE status IN ('Approved', 'Completed', 'Captured')) as captured
      FROM opportunities
      WHERE pharmacy_id = $1
        AND updated_at >= $2 AND updated_at <= $3
      GROUP BY DATE(updated_at)
      ORDER BY date
    `, [pharmacyId, startDate, endDate + ' 23:59:59']);
    
    res.json({
      month: monthNum,
      year: yearNum,
      total_opportunities: parseInt(stats.total_opportunities) || 0,
      new_opportunities: parseInt(stats.new_opportunities) || 0,
      submitted: parseInt(stats.submitted) || 0,
      captured: parseInt(stats.captured) || 0,
      rejected: parseInt(stats.rejected) || 0,
      total_value: parseFloat(stats.total_value) || 0,
      captured_value: parseFloat(stats.captured_value) || 0,
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
      })),
    });
  } catch (error) {
    logger.error('Monthly report error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to get monthly report' });
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
    
    // Get all opportunities for the month
    const result = await db.query(`
      SELECT 
        o.opportunity_id,
        p.first_name || ' ' || p.last_name as patient_name,
        o.trigger_type,
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
        r.patient_name || 'Unknown',
        r.trigger_type || 'Other',
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
      res.json({ opportunities: result.rows });
    }
  } catch (error) {
    logger.error('Export error', { error: error.message });
    res.status(500).json({ error: 'Failed to export report' });
  }
});

// Audit flags for pharmacy
router.get('/audit-flags', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { status, severity, limit = 100, offset = 0 } = req.query;

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

    res.json({
      flags: result.rows,
      total: result.rows.length,
      counts: {
        byStatus: countsResult.rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count) }), {}),
        bySeverity: severityResult.rows.reduce((acc, r) => ({ ...acc, [r.severity]: parseInt(r.count) }), {})
      }
    });
  } catch (error) {
    logger.error('Fetch audit flags error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch audit flags' });
  }
});

// Update audit flag status
router.put('/audit-flags/:flagId', authenticateToken, async (req, res) => {
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

export default router;
