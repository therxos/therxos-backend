// Data Quality Issues routes for TheRxOS V2
import express from 'express';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';
import { formatPatientName, formatPrescriberName } from '../utils/formatters.js';

const router = express.Router();

// Get data quality issues for pharmacy (admin only)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status = 'pending', issue_type, limit = 100, offset = 0 } = req.query;

    // Super admins can specify a pharmacyId, or see all if not specified
    let pharmacyId = req.user.pharmacyId;
    if (req.user.role === 'super_admin' && req.query.pharmacyId) {
      pharmacyId = req.query.pharmacyId;
    } else if (req.user.role === 'super_admin') {
      pharmacyId = null; // Show all pharmacies
    }

    // Only admins and super_admins can view data quality issues
    if (!['super_admin', 'admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions to view data quality issues' });
    }

    let query = `
      SELECT
        dqi.*,
        ph.pharmacy_name,
        p.first_name as patient_first_name,
        p.last_name as patient_last_name,
        o.current_drug_name,
        o.recommended_drug_name,
        o.potential_margin_gain,
        o.annual_margin_gain,
        o.opportunity_type,
        o.trigger_type,
        pr.drug_name as prescription_drug_name,
        pr.prescriber_name as prescription_prescriber_name,
        u.first_name as resolved_by_first,
        u.last_name as resolved_by_last
      FROM data_quality_issues dqi
      LEFT JOIN pharmacies ph ON ph.pharmacy_id = dqi.pharmacy_id
      LEFT JOIN patients p ON p.patient_id = dqi.patient_id
      LEFT JOIN opportunities o ON o.opportunity_id = dqi.opportunity_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = dqi.prescription_id
      LEFT JOIN users u ON u.user_id = dqi.resolved_by
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // Super admins see all pharmacies unless they specify one
    if (pharmacyId) {
      query += ` AND dqi.pharmacy_id = $${paramIndex++}`;
      params.push(pharmacyId);
    }

    if (status && status !== 'all') {
      query += ` AND dqi.status = $${paramIndex++}`;
      params.push(status);
    }
    if (issue_type) {
      query += ` AND dqi.issue_type = $${paramIndex++}`;
      params.push(issue_type);
    }

    query += ` ORDER BY dqi.created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Format results
    const formattedIssues = result.rows.map(issue => ({
      ...issue,
      patient_name: formatPatientName(issue.patient_first_name, issue.patient_last_name),
      prescriber_name_formatted: formatPrescriberName(issue.prescription_prescriber_name),
      resolved_by_name: issue.resolved_by_first ? formatPatientName(issue.resolved_by_first, issue.resolved_by_last) : null
    }));

    // Get counts by status
    const statusCountsQuery = pharmacyId
      ? `SELECT status, COUNT(*) as count FROM data_quality_issues WHERE pharmacy_id = $1 GROUP BY status`
      : `SELECT status, COUNT(*) as count FROM data_quality_issues GROUP BY status`;
    const statusCounts = await db.query(statusCountsQuery, pharmacyId ? [pharmacyId] : []);

    // Get counts by issue type
    const typeCountsQuery = pharmacyId
      ? `SELECT issue_type, COUNT(*) as count FROM data_quality_issues WHERE pharmacy_id = $1 AND status = 'pending' GROUP BY issue_type ORDER BY count DESC`
      : `SELECT issue_type, COUNT(*) as count FROM data_quality_issues WHERE status = 'pending' GROUP BY issue_type ORDER BY count DESC`;
    const typeCounts = await db.query(typeCountsQuery, pharmacyId ? [pharmacyId] : []);

    res.json({
      issues: formattedIssues,
      counts: {
        byStatus: statusCounts.rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count) }), {}),
        byType: typeCounts.rows.reduce((acc, r) => ({ ...acc, [r.issue_type]: parseInt(r.count) }), {})
      },
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: statusCounts.rows.reduce((sum, r) => sum + parseInt(r.count), 0)
      }
    });
  } catch (error) {
    logger.error('Get data quality issues error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to get data quality issues', details: error.message });
  }
});

// Get single data quality issue with full details
router.get('/:issueId', authenticateToken, async (req, res) => {
  try {
    const { issueId } = req.params;
    const pharmacyId = req.user.pharmacyId;

    // Only admins can view
    if (!['super_admin', 'admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const result = await db.query(`
      SELECT
        dqi.*,
        p.first_name as patient_first_name,
        p.last_name as patient_last_name,
        p.patient_hash,
        p.date_of_birth,
        o.current_drug_name,
        o.recommended_drug_name,
        o.prescriber_name as opportunity_prescriber,
        o.potential_margin_gain,
        o.annual_margin_gain,
        o.opportunity_type,
        o.trigger_type,
        o.status as opportunity_status,
        pr.rx_number,
        pr.drug_name as prescription_drug_name,
        pr.prescriber_name as prescription_prescriber_name,
        pr.prescriber_npi,
        pr.dispensed_date,
        pr.quantity_dispensed,
        pr.days_supply,
        u.email as resolved_by_email,
        u.first_name as resolved_by_first,
        u.last_name as resolved_by_last
      FROM data_quality_issues dqi
      LEFT JOIN patients p ON p.patient_id = dqi.patient_id
      LEFT JOIN opportunities o ON o.opportunity_id = dqi.opportunity_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = dqi.prescription_id
      LEFT JOIN users u ON u.user_id = dqi.resolved_by
      WHERE dqi.issue_id = $1 AND dqi.pharmacy_id = $2
    `, [issueId, pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Data quality issue not found' });
    }

    const issue = result.rows[0];
    res.json({
      ...issue,
      patient_name: formatPatientName(issue.patient_first_name, issue.patient_last_name),
      prescriber_name_formatted: formatPrescriberName(issue.prescription_prescriber_name || issue.opportunity_prescriber),
      resolved_by_name: issue.resolved_by_first ? formatPatientName(issue.resolved_by_first, issue.resolved_by_last) : null
    });
  } catch (error) {
    logger.error('Get data quality issue error', { error: error.message });
    res.status(500).json({ error: 'Failed to get data quality issue' });
  }
});

// Update data quality issue (resolve, ignore, etc.)
router.patch('/:issueId', authenticateToken, async (req, res) => {
  try {
    const { issueId } = req.params;
    const { status, resolved_value, resolution_notes } = req.body;
    const pharmacyId = req.user.pharmacyId;

    // Only admins can update
    if (!['super_admin', 'admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    // Verify the issue exists (super admins can update any, others only their pharmacy)
    let existing;
    if (req.user.role === 'super_admin') {
      existing = await db.query(
        'SELECT * FROM data_quality_issues WHERE issue_id = $1',
        [issueId]
      );
    } else {
      existing = await db.query(
        'SELECT * FROM data_quality_issues WHERE issue_id = $1 AND pharmacy_id = $2',
        [issueId, pharmacyId]
      );
    }

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Data quality issue not found' });
    }

    const updates = {
      updated_at: new Date()
    };

    if (status) {
      updates.status = status;
      if (status === 'resolved' || status === 'ignored' || status === 'auto_fixed') {
        updates.resolved_by = req.user.userId;
        updates.resolved_at = new Date();
      }
    }
    if (resolved_value !== undefined) {
      updates.resolved_value = resolved_value;
    }
    if (resolution_notes !== undefined) {
      updates.resolution_notes = resolution_notes;
    }

    const result = await db.update('data_quality_issues', 'issue_id', issueId, updates);

    // If resolved and we have a resolved_value, update the opportunity
    if (status === 'resolved' && resolved_value && existing.rows[0].opportunity_id) {
      const issue = existing.rows[0];
      if (issue.field_name === 'prescriber_name') {
        await db.query(
          'UPDATE opportunities SET prescriber_name = $1, updated_at = NOW() WHERE opportunity_id = $2',
          [resolved_value, issue.opportunity_id]
        );
        logger.info('Updated opportunity prescriber from data quality resolution', {
          opportunityId: issue.opportunity_id,
          newValue: resolved_value
        });
      } else if (issue.field_name === 'current_drug_name') {
        await db.query(
          'UPDATE opportunities SET current_drug_name = $1, updated_at = NOW() WHERE opportunity_id = $2',
          [resolved_value, issue.opportunity_id]
        );
        logger.info('Updated opportunity drug from data quality resolution', {
          opportunityId: issue.opportunity_id,
          newValue: resolved_value
        });
      }
    }

    logger.info('Data quality issue updated', {
      issueId,
      status,
      userId: req.user.userId
    });

    res.json(result);
  } catch (error) {
    logger.error('Update data quality issue error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to update data quality issue' });
  }
});

// Bulk update data quality issues
router.post('/bulk-update', authenticateToken, async (req, res) => {
  try {
    const { issueIds, status, resolution_notes } = req.body;
    const pharmacyId = req.user.pharmacyId;

    // Only admins can update
    if (!['super_admin', 'admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    if (!Array.isArray(issueIds) || issueIds.length === 0) {
      return res.status(400).json({ error: 'issueIds must be a non-empty array' });
    }

    // Super admins can update any pharmacy's issues
    let result;
    if (req.user.role === 'super_admin') {
      result = await db.query(`
        UPDATE data_quality_issues
        SET status = $1,
            resolved_by = $2,
            resolved_at = $3,
            resolution_notes = COALESCE($4, resolution_notes),
            updated_at = NOW()
        WHERE issue_id = ANY($5)
        RETURNING issue_id
      `, [
        status,
        req.user.userId,
        new Date(),
        resolution_notes,
        issueIds
      ]);
    } else {
      result = await db.query(`
        UPDATE data_quality_issues
        SET status = $1,
            resolved_by = $2,
            resolved_at = $3,
            resolution_notes = COALESCE($4, resolution_notes),
            updated_at = NOW()
        WHERE issue_id = ANY($5)
          AND pharmacy_id = $6
        RETURNING issue_id
      `, [
        status,
        req.user.userId,
        new Date(),
        resolution_notes,
        issueIds,
        pharmacyId
      ]);
    }

    logger.info('Bulk data quality update', {
      count: result.rows.length,
      status,
      userId: req.user.userId
    });

    res.json({
      success: true,
      updated: result.rows.length,
      ids: result.rows.map(r => r.issue_id)
    });
  } catch (error) {
    logger.error('Bulk update data quality error', { error: error.message });
    res.status(500).json({ error: 'Failed to bulk update data quality issues' });
  }
});

// Get data quality summary statistics
router.get('/stats/summary', authenticateToken, async (req, res) => {
  try {
    // Super admins can specify a pharmacyId, or see all if not specified
    let pharmacyId = req.user.pharmacyId;
    if (req.user.role === 'super_admin' && req.query.pharmacyId) {
      pharmacyId = req.query.pharmacyId;
    } else if (req.user.role === 'super_admin') {
      pharmacyId = null; // Show all pharmacies
    }

    // Only admins can view
    if (!['super_admin', 'admin', 'owner'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const pharmacyFilter = pharmacyId ? 'WHERE pharmacy_id = $1' : 'WHERE 1=1';
    const params = pharmacyId ? [pharmacyId] : [];

    // Overall counts
    const overallStats = await db.query(`
      SELECT
        COUNT(*) as total_issues,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_issues,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved_issues,
        COUNT(*) FILTER (WHERE status = 'ignored') as ignored_issues,
        COUNT(*) FILTER (WHERE status = 'auto_fixed') as auto_fixed_issues
      FROM data_quality_issues
      ${pharmacyFilter}
    `, params);

    // Impact on opportunities (how much margin is blocked)
    const impactStats = await db.query(`
      SELECT
        COUNT(DISTINCT dqi.opportunity_id) as affected_opportunities,
        COALESCE(SUM(o.annual_margin_gain), 0) as blocked_annual_margin
      FROM data_quality_issues dqi
      JOIN opportunities o ON o.opportunity_id = dqi.opportunity_id
      WHERE ${pharmacyId ? 'dqi.pharmacy_id = $1 AND' : ''} dqi.status = 'pending'
    `, params);

    // By issue type
    const byType = await db.query(`
      SELECT
        issue_type,
        COUNT(*) as count,
        COUNT(*) FILTER (WHERE status = 'pending') as pending
      FROM data_quality_issues
      ${pharmacyFilter}
      GROUP BY issue_type
      ORDER BY pending DESC
    `, params);

    // Recent activity
    const recentResolutions = await db.query(`
      SELECT
        DATE(resolved_at) as date,
        COUNT(*) as resolved_count
      FROM data_quality_issues
      WHERE ${pharmacyId ? 'pharmacy_id = $1 AND' : ''} resolved_at >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(resolved_at)
      ORDER BY date DESC
    `, params);

    res.json({
      overall: overallStats.rows[0],
      impact: impactStats.rows[0],
      byType: byType.rows,
      recentActivity: recentResolutions.rows
    });
  } catch (error) {
    logger.error('Get data quality stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get data quality stats', details: error.message });
  }
});

export default router;
