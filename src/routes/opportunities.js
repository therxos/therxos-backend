// Opportunity routes for TheRxOS V2
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Get opportunities for authenticated user's pharmacy
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, type, priority, search, sortBy = 'margin', sortOrder = 'desc', limit = 50, offset = 0 } = req.query;
    const pharmacyId = req.user.pharmacyId;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }

    let query = `
      SELECT o.*, 
        p.patient_hash,
        p.chronic_conditions,
        p.primary_insurance_bin,
        pr.drug_name as current_drug
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.pharmacy_id = $1
    `;
    const params = [pharmacyId];
    let paramIndex = 2;

    // Filters
    if (status) {
      query += ` AND o.status = $${paramIndex++}`;
      params.push(status);
    }
    if (type) {
      query += ` AND o.opportunity_type = $${paramIndex++}`;
      params.push(type);
    }
    if (priority) {
      query += ` AND o.clinical_priority = $${paramIndex++}`;
      params.push(priority);
    }
    if (search) {
      query += ` AND (o.current_drug_name ILIKE $${paramIndex} OR o.recommended_drug_name ILIKE $${paramIndex} OR o.clinical_rationale ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Sorting
    const sortColumn = {
      margin: 'o.potential_margin_gain',
      date: 'o.created_at',
      priority: 'o.clinical_priority',
      type: 'o.opportunity_type'
    }[sortBy] || 'o.potential_margin_gain';

    query += ` ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'}`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get counts by status
    const countsResult = await db.query(`
      SELECT 
        status,
        COUNT(*) as count,
        SUM(potential_margin_gain) as total_margin
      FROM opportunities
      WHERE pharmacy_id = $1
      GROUP BY status
    `, [pharmacyId]);

    const counts = {};
    for (const row of countsResult.rows) {
      counts[row.status] = {
        count: parseInt(row.count),
        totalMargin: parseFloat(row.total_margin) || 0
      };
    }

    res.json({
      opportunities: result.rows,
      counts,
      pagination: {
        limit: parseInt(limit),
        offset: parseInt(offset),
        total: Object.values(counts).reduce((sum, c) => sum + c.count, 0)
      }
    });
  } catch (error) {
    logger.error('Get opportunities error', { error: error.message });
    res.status(500).json({ error: 'Failed to get opportunities' });
  }
});

// Get single opportunity
router.get('/:opportunityId', authenticateToken, async (req, res) => {
  try {
    const { opportunityId } = req.params;

    const result = await db.query(`
      SELECT o.*,
        p.patient_hash, p.chronic_conditions, p.date_of_birth, p.primary_insurance_bin, p.primary_insurance_pcn, p.primary_insurance_group,
        pr.rx_number, pr.quantity_dispensed, pr.days_supply, pr.sig, pr.prescriber_name, pr.prescriber_npi,
        nr_current.drug_name as current_ndc_drug, nr_current.manufacturer as current_manufacturer, nr_current.is_brand as current_is_brand,
        nr_rec.drug_name as recommended_ndc_drug, nr_rec.manufacturer as recommended_manufacturer, nr_rec.is_brand as recommended_is_brand
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN ndc_reference nr_current ON nr_current.ndc = o.current_ndc
      LEFT JOIN ndc_reference nr_rec ON nr_rec.ndc = o.recommended_ndc
      WHERE o.opportunity_id = $1 AND o.pharmacy_id = $2
    `, [opportunityId, req.user.pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    // Get action history
    const actions = await db.query(`
      SELECT oa.*, u.first_name, u.last_name
      FROM opportunity_actions oa
      LEFT JOIN users u ON u.user_id = oa.performed_by
      WHERE oa.opportunity_id = $1
      ORDER BY oa.performed_at DESC
    `, [opportunityId]);

    res.json({
      ...result.rows[0],
      actions: actions.rows
    });
  } catch (error) {
    logger.error('Get opportunity error', { error: error.message });
    res.status(500).json({ error: 'Failed to get opportunity' });
  }
});

// Update opportunity (approve, dismiss, review)
router.patch('/:opportunityId', authenticateToken, async (req, res) => {
  try {
    const { opportunityId } = req.params;
    const { status, staffNotes, dismissedReason, actualMarginRealized } = req.body;

    // Verify ownership
    const existing = await db.query(
      'SELECT * FROM opportunities WHERE opportunity_id = $1 AND pharmacy_id = $2',
      [opportunityId, req.user.pharmacyId]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    const updates = {};
    const actionType = status;

    if (status) {
      updates.status = status;
      
      if (status === 'reviewed') {
        updates.reviewed_by = req.user.userId;
        updates.reviewed_at = new Date();
      } else if (status === 'actioned') {
        updates.actioned_by = req.user.userId;
        updates.actioned_at = new Date();
      } else if (status === 'dismissed') {
        updates.dismissed_reason = dismissedReason;
      }
    }

    if (staffNotes !== undefined) {
      updates.staff_notes = staffNotes;
    }

    if (actualMarginRealized !== undefined) {
      updates.actual_margin_realized = actualMarginRealized;
    }

    const result = await db.update('opportunities', 'opportunity_id', opportunityId, updates);

    // Log the action
    await db.insert('opportunity_actions', {
      action_id: uuidv4(),
      opportunity_id: opportunityId,
      action_type: actionType || 'updated',
      action_details: JSON.stringify({ updates }),
      performed_by: req.user.userId,
      outcome: 'success'
    });

    logger.info('Opportunity updated', {
      opportunityId,
      userId: req.user.userId,
      newStatus: status
    });

    res.json(result);
  } catch (error) {
    logger.error('Update opportunity error', { error: error.message });
    res.status(500).json({ error: 'Failed to update opportunity' });
  }
});

// Bulk update opportunities
router.post('/bulk-update', authenticateToken, async (req, res) => {
  try {
    const { opportunityIds, status, staffNotes } = req.body;

    if (!Array.isArray(opportunityIds) || opportunityIds.length === 0) {
      return res.status(400).json({ error: 'opportunityIds must be a non-empty array' });
    }

    const updates = { status };
    if (status === 'reviewed') {
      updates.reviewed_by = req.user.userId;
      updates.reviewed_at = new Date();
    } else if (status === 'actioned') {
      updates.actioned_by = req.user.userId;
      updates.actioned_at = new Date();
    }
    if (staffNotes) {
      updates.staff_notes = staffNotes;
    }

    const result = await db.query(`
      UPDATE opportunities
      SET status = $1,
          reviewed_by = $2,
          reviewed_at = $3,
          actioned_by = $4,
          actioned_at = $5,
          staff_notes = COALESCE($6, staff_notes),
          updated_at = NOW()
      WHERE opportunity_id = ANY($7)
        AND pharmacy_id = $8
      RETURNING opportunity_id
    `, [
      updates.status,
      updates.reviewed_by || null,
      updates.reviewed_at || null,
      updates.actioned_by || null,
      updates.actioned_at || null,
      staffNotes,
      opportunityIds,
      req.user.pharmacyId
    ]);

    logger.info('Bulk opportunity update', {
      count: result.rows.length,
      status,
      userId: req.user.userId
    });

    res.json({
      success: true,
      updated: result.rows.length,
      ids: result.rows.map(r => r.opportunity_id)
    });
  } catch (error) {
    logger.error('Bulk update error', { error: error.message });
    res.status(500).json({ error: 'Failed to update opportunities' });
  }
});

// Get opportunity summary/stats
router.get('/summary/stats', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { days = 30 } = req.query;

    const stats = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'new') as new_count,
        COUNT(*) FILTER (WHERE status = 'reviewed') as reviewed_count,
        COUNT(*) FILTER (WHERE status = 'actioned') as actioned_count,
        COUNT(*) FILTER (WHERE status = 'dismissed') as dismissed_count,
        COALESCE(SUM(potential_margin_gain) FILTER (WHERE status = 'new'), 0) as new_margin,
        COALESCE(SUM(actual_margin_realized) FILTER (WHERE status = 'actioned'), 0) as realized_margin,
        COUNT(DISTINCT patient_id) FILTER (WHERE status = 'new') as patients_with_opportunities
      FROM opportunities
      WHERE pharmacy_id = $1
        AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
    `, [pharmacyId]);

    const byType = await db.query(`
      SELECT 
        opportunity_type,
        COUNT(*) as count,
        SUM(potential_margin_gain) as total_margin
      FROM opportunities
      WHERE pharmacy_id = $1
        AND status = 'new'
      GROUP BY opportunity_type
      ORDER BY total_margin DESC
    `, [pharmacyId]);

    const trend = await db.query(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as count,
        SUM(potential_margin_gain) as margin
      FROM opportunities
      WHERE pharmacy_id = $1
        AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `, [pharmacyId]);

    res.json({
      ...stats.rows[0],
      byType: byType.rows,
      trend: trend.rows
    });
  } catch (error) {
    logger.error('Get stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

export default router;
