// Opportunity Approval Queue routes
// Admin review queue for new opportunity types before they go live
import express from 'express';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';

const router = express.Router();

// Middleware to require super_admin role
const requireSuperAdmin = (req, res, next) => {
  if (req.user.role !== 'super_admin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
};

// Get all pending opportunity types for review
router.get('/', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { status = 'pending', limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT
        pot.*,
        u.first_name as reviewer_first,
        u.last_name as reviewer_last,
        t.display_name as trigger_name
      FROM pending_opportunity_types pot
      LEFT JOIN users u ON u.user_id = pot.reviewed_by
      LEFT JOIN triggers t ON t.trigger_id = pot.created_trigger_id
    `;

    const params = [];
    let paramIndex = 1;

    if (status && status !== 'all') {
      query += ` WHERE pot.status = $${paramIndex++}`;
      params.push(status);
    }

    query += ` ORDER BY pot.created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Resolve pharmacy UUIDs to names for all items
    const allPharmacyIds = new Set();
    result.rows.forEach(row => {
      if (row.affected_pharmacies && Array.isArray(row.affected_pharmacies)) {
        row.affected_pharmacies.forEach(id => allPharmacyIds.add(id));
      }
    });

    let pharmacyNameMap = {};
    if (allPharmacyIds.size > 0) {
      const pharmacyResult = await db.query(`
        SELECT pharmacy_id, pharmacy_name
        FROM pharmacies
        WHERE pharmacy_id = ANY($1)
      `, [Array.from(allPharmacyIds)]);
      pharmacyResult.rows.forEach(p => {
        pharmacyNameMap[p.pharmacy_id] = p.pharmacy_name;
      });
    }

    // Check which items already have matching triggers
    const recommendedDrugs = result.rows.map(r => r.recommended_drug_name).filter(Boolean);
    let existingTriggerMap = {};
    if (recommendedDrugs.length > 0) {
      const triggerResult = await db.query(`
        SELECT trigger_id, trigger_code, display_name, recommended_drug
        FROM triggers
        WHERE LOWER(recommended_drug) = ANY($1)
      `, [recommendedDrugs.map(d => d?.toLowerCase())]);
      triggerResult.rows.forEach(t => {
        existingTriggerMap[t.recommended_drug?.toLowerCase()] = {
          trigger_id: t.trigger_id,
          trigger_name: t.trigger_code,
          display_name: t.display_name
        };
      });
    }

    // Add resolved pharmacy names and existing trigger info to each item
    const itemsWithPharmacyNames = result.rows.map(row => ({
      ...row,
      affected_pharmacy_names: row.affected_pharmacies
        ? row.affected_pharmacies.map(id => pharmacyNameMap[id] || id)
        : [],
      existing_trigger: existingTriggerMap[row.recommended_drug_name?.toLowerCase()] || null
    }));

    // Get counts by status
    const counts = await db.query(`
      SELECT status, COUNT(*) as count
      FROM pending_opportunity_types
      GROUP BY status
    `);

    res.json({
      items: itemsWithPharmacyNames,
      counts: counts.rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count) }), {}),
      pagination: { limit: parseInt(limit), offset: parseInt(offset) }
    });
  } catch (error) {
    logger.error('Get pending opportunity types error', { error: error.message });
    res.status(500).json({ error: 'Failed to get pending opportunity types' });
  }
});

// Get single pending opportunity type with full details
router.get('/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT
        pot.*,
        u.first_name as reviewer_first,
        u.last_name as reviewer_last,
        u.email as reviewer_email
      FROM pending_opportunity_types pot
      LEFT JOIN users u ON u.user_id = pot.reviewed_by
      WHERE pot.pending_type_id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pending opportunity type not found' });
    }

    const item = result.rows[0];

    // Resolve affected pharmacy UUIDs to names
    let affectedPharmaciesResolved = [];
    if (item.affected_pharmacies && Array.isArray(item.affected_pharmacies)) {
      const pharmacyResult = await db.query(`
        SELECT pharmacy_id, pharmacy_name
        FROM pharmacies
        WHERE pharmacy_id = ANY($1)
      `, [item.affected_pharmacies]);

      affectedPharmaciesResolved = pharmacyResult.rows.map(p => ({
        pharmacy_id: p.pharmacy_id,
        pharmacy_name: p.pharmacy_name
      }));
    }

    // Get sample opportunities with more context (current drug, insurance info)
    const sampleOpps = await db.query(`
      SELECT
        o.opportunity_id,
        o.patient_id,
        o.current_drug_name,
        o.prescriber_name,
        o.potential_margin_gain,
        o.annual_margin_gain,
        o.status as opp_status,
        p.first_name || ' ' || p.last_name as patient_name,
        pr.insurance_bin,
        pr.insurance_group,
        pr.plan_name,
        ph.pharmacy_name,
        (SELECT COUNT(*) FROM opportunities o2 WHERE o2.patient_id = o.patient_id AND o2.status != 'Not Submitted') as patient_actioned_count
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
      WHERE o.recommended_drug_name = $1
      ORDER BY o.annual_margin_gain DESC NULLS LAST
      LIMIT 20
    `, [item.recommended_drug_name]);

    // Get BIN/Group breakdown for this opportunity type
    const binBreakdown = await db.query(`
      SELECT
        COALESCE(pr.insurance_bin, 'CASH') as bin,
        COALESCE(pr.insurance_group, '') as grp,
        pr.plan_name,
        COUNT(*) as count,
        COALESCE(SUM(o.annual_margin_gain), 0) as total_margin
      FROM opportunities o
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.recommended_drug_name = $1
      GROUP BY pr.insurance_bin, pr.insurance_group, pr.plan_name
      ORDER BY count DESC
      LIMIT 20
    `, [item.recommended_drug_name]);

    // Get current drug breakdown (what drugs triggered these opportunities)
    const currentDrugBreakdown = await db.query(`
      SELECT
        o.current_drug_name,
        COUNT(*) as count,
        COALESCE(SUM(o.annual_margin_gain), 0) as total_margin
      FROM opportunities o
      WHERE o.recommended_drug_name = $1
        AND o.current_drug_name IS NOT NULL
      GROUP BY o.current_drug_name
      ORDER BY count DESC
      LIMIT 20
    `, [item.recommended_drug_name]);

    // Get approval history
    const history = await db.query(`
      SELECT
        oal.*,
        u.first_name,
        u.last_name,
        u.email
      FROM opportunity_approval_log oal
      LEFT JOIN users u ON u.user_id = oal.performed_by
      WHERE oal.pending_type_id = $1
      ORDER BY oal.created_at DESC
    `, [id]);

    res.json({
      ...item,
      affected_pharmacies_resolved: affectedPharmaciesResolved,
      sample_opportunities: sampleOpps.rows,
      bin_breakdown: binBreakdown.rows,
      current_drug_breakdown: currentDrugBreakdown.rows,
      history: history.rows
    });
  } catch (error) {
    logger.error('Get pending opportunity type error', { error: error.message });
    res.status(500).json({ error: 'Failed to get pending opportunity type' });
  }
});

// Approve a pending opportunity type - ALWAYS creates a trigger for future scanning
router.post('/:id/approve', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, triggerConfig = {} } = req.body;

    // Get the pending item with sample data
    const existing = await db.query(
      'SELECT * FROM pending_opportunity_types WHERE pending_type_id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Pending opportunity type not found' });
    }

    const item = existing.rows[0];

    // Check if trigger already exists for this drug
    const existingTrigger = await db.query(
      'SELECT trigger_id, display_name FROM triggers WHERE LOWER(recommended_drug) = LOWER($1)',
      [item.recommended_drug_name]
    );

    let createdTriggerId = null;
    let triggerAction = 'none';

    if (existingTrigger.rows.length > 0) {
      // Trigger already exists, just link to it
      createdTriggerId = existingTrigger.rows[0].trigger_id;
      triggerAction = 'linked_existing';
      logger.info('Linked approval to existing trigger', {
        triggerId: createdTriggerId,
        triggerName: existingTrigger.rows[0].display_name
      });
    } else {
      // Extract detection keywords from sample data or use recommended drug name
      let detectionKeywords = triggerConfig.detection_keywords || [];

      if (detectionKeywords.length === 0) {
        // Try to extract from sample data (current_drug values)
        const sampleData = item.sample_data || {};
        if (sampleData.current_drugs && Array.isArray(sampleData.current_drugs)) {
          // Extract unique drug name patterns
          const drugPatterns = new Set();
          sampleData.current_drugs.forEach(drug => {
            if (drug) {
              // Extract the base drug name (first word or before strength)
              const baseName = drug.split(/\s+\d|\s+\(|\s+-/)[0].trim();
              if (baseName.length >= 3) {
                drugPatterns.add(baseName.toLowerCase());
              }
            }
          });
          detectionKeywords = Array.from(drugPatterns).slice(0, 10); // Limit to 10 keywords
        }

        // If still no keywords, use the recommended drug name parts
        if (detectionKeywords.length === 0) {
          const drugWords = item.recommended_drug_name
            .split(/[\s\-]+/)
            .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !['mg', 'ml', 'mcg'].includes(w.toLowerCase()));
          detectionKeywords = drugWords.slice(0, 5);
        }
      }

      // Generate trigger name from recommended drug
      const triggerName = triggerConfig.trigger_name ||
        item.recommended_drug_name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 50);

      // Create the trigger
      const triggerResult = await db.query(`
        INSERT INTO triggers (
          trigger_name,
          display_name,
          recommended_drug,
          detection_keywords,
          trigger_type,
          trigger_group,
          is_enabled,
          default_gp_value,
          annual_fills,
          clinical_rationale,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8, $9, NOW())
        RETURNING trigger_id
      `, [
        triggerName,
        triggerConfig.display_name || item.recommended_drug_name,
        item.recommended_drug_name,
        detectionKeywords,
        triggerConfig.trigger_type || item.opportunity_type || 'therapeutic_interchange',
        triggerConfig.trigger_group || null,
        triggerConfig.default_gp_value || Math.round((item.estimated_annual_margin || 0) / Math.max(item.total_patient_count || 1, 1) / 12),
        triggerConfig.annual_fills || 12,
        triggerConfig.clinical_rationale || `Approved opportunity type: ${item.recommended_drug_name}`
      ]);

      createdTriggerId = triggerResult.rows[0].trigger_id;
      triggerAction = 'created_new';

      logger.info('Created new trigger from approval', {
        triggerId: createdTriggerId,
        triggerName,
        detectionKeywords,
        recommendedDrug: item.recommended_drug_name
      });
    }

    // Update status to approved
    await db.query(`
      UPDATE pending_opportunity_types
      SET status = 'approved',
          reviewed_by = $1,
          reviewed_at = NOW(),
          review_notes = $2,
          created_trigger_id = $3,
          updated_at = NOW()
      WHERE pending_type_id = $4
    `, [req.user.userId, notes, createdTriggerId, id]);

    // Log the approval
    await db.query(`
      INSERT INTO opportunity_approval_log (
        pending_type_id, action, performed_by, previous_status, new_status, notes
      ) VALUES ($1, 'approved', $2, $3, 'approved', $4)
    `, [id, req.user.userId, item.status, notes]);

    // Get the created/linked trigger details
    const triggerDetails = await db.query(
      'SELECT trigger_id, trigger_name, display_name, detection_keywords FROM triggers WHERE trigger_id = $1',
      [createdTriggerId]
    );

    logger.info('Opportunity type approved', {
      pendingTypeId: id,
      recommendedDrug: item.recommended_drug_name,
      approvedBy: req.user.userId,
      createdTriggerId,
      triggerAction
    });

    res.json({
      success: true,
      message: triggerAction === 'created_new'
        ? `Opportunity type approved and trigger "${triggerDetails.rows[0]?.display_name}" created`
        : `Opportunity type approved and linked to existing trigger "${triggerDetails.rows[0]?.display_name}"`,
      createdTriggerId,
      triggerAction,
      trigger: triggerDetails.rows[0] || null
    });
  } catch (error) {
    logger.error('Approve opportunity type error', { error: error.message });
    res.status(500).json({ error: 'Failed to approve opportunity type: ' + error.message });
  }
});

// Reject a pending opportunity type
router.post('/:id/reject', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, deleteExistingOpportunities = false } = req.body;

    // Get the pending item
    const existing = await db.query(
      'SELECT * FROM pending_opportunity_types WHERE pending_type_id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Pending opportunity type not found' });
    }

    const item = existing.rows[0];

    // Optionally delete existing opportunities with this recommended_drug_name
    let deletedCount = 0;
    if (deleteExistingOpportunities) {
      const deleteResult = await db.query(`
        DELETE FROM opportunities
        WHERE recommended_drug_name = $1
        RETURNING opportunity_id
      `, [item.recommended_drug_name]);
      deletedCount = deleteResult.rows.length;
    }

    // Update status to rejected
    await db.query(`
      UPDATE pending_opportunity_types
      SET status = 'rejected',
          reviewed_by = $1,
          reviewed_at = NOW(),
          review_notes = $2,
          updated_at = NOW()
      WHERE pending_type_id = $3
    `, [req.user.userId, notes, id]);

    // Log the rejection
    await db.query(`
      INSERT INTO opportunity_approval_log (
        pending_type_id, action, performed_by, previous_status, new_status, notes
      ) VALUES ($1, 'rejected', $2, $3, 'rejected', $4)
    `, [id, req.user.userId, item.status, notes]);

    logger.info('Opportunity type rejected', {
      pendingTypeId: id,
      recommendedDrug: item.recommended_drug_name,
      rejectedBy: req.user.userId,
      deletedOpportunities: deletedCount
    });

    res.json({
      success: true,
      message: 'Opportunity type rejected',
      deletedOpportunities: deletedCount
    });
  } catch (error) {
    logger.error('Reject opportunity type error', { error: error.message });
    res.status(500).json({ error: 'Failed to reject opportunity type' });
  }
});

// Submit new opportunity types to queue (called by scanners)
router.post('/submit', authenticateToken, async (req, res) => {
  try {
    const {
      recommended_drug_name,
      opportunity_type,
      source,
      source_details,
      sample_data,
      affected_pharmacies,
      total_patient_count,
      estimated_annual_margin
    } = req.body;

    // Check if this type already exists in queue (use FOR UPDATE to prevent race conditions)
    const existing = await db.query(
      'SELECT * FROM pending_opportunity_types WHERE LOWER(recommended_drug_name) = LOWER($1) AND status = $2 FOR UPDATE',
      [recommended_drug_name, 'pending']
    );

    if (existing.rows.length > 0) {
      // Update existing - replace counts (don't add, to avoid inflation on re-scan)
      await db.query(`
        UPDATE pending_opportunity_types
        SET total_patient_count = GREATEST(total_patient_count, $1),
            estimated_annual_margin = GREATEST(estimated_annual_margin, $2),
            sample_data = COALESCE($3, sample_data),
            source_details = COALESCE($4, source_details),
            updated_at = NOW()
        WHERE pending_type_id = $5
      `, [total_patient_count || 0, estimated_annual_margin || 0, sample_data, source_details, existing.rows[0].pending_type_id]);

      return res.json({
        success: true,
        pendingTypeId: existing.rows[0].pending_type_id,
        message: 'Updated existing pending opportunity type'
      });
    }

    // Create new pending item
    const result = await db.query(`
      INSERT INTO pending_opportunity_types (
        recommended_drug_name,
        opportunity_type,
        source,
        source_details,
        sample_data,
        affected_pharmacies,
        total_patient_count,
        estimated_annual_margin
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING pending_type_id
    `, [
      recommended_drug_name,
      opportunity_type || 'unknown',
      source || 'manual',
      source_details,
      sample_data,
      affected_pharmacies,
      total_patient_count || 0,
      estimated_annual_margin || 0
    ]);

    logger.info('New opportunity type submitted for approval', {
      pendingTypeId: result.rows[0].pending_type_id,
      recommendedDrug: recommended_drug_name,
      source
    });

    res.json({
      success: true,
      pendingTypeId: result.rows[0].pending_type_id,
      message: 'Opportunity type submitted for approval'
    });
  } catch (error) {
    logger.error('Submit opportunity type error', { error: error.message });
    res.status(500).json({ error: 'Failed to submit opportunity type for approval' });
  }
});

// Bulk delete unauthorized opportunities (cleanup endpoint)
router.post('/cleanup', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { recommended_drug_names, pharmacyId } = req.body;

    if (!Array.isArray(recommended_drug_names) || recommended_drug_names.length === 0) {
      return res.status(400).json({ error: 'recommended_drug_names must be a non-empty array' });
    }

    let query = `
      DELETE FROM opportunities
      WHERE recommended_drug_name = ANY($1)
    `;
    const params = [recommended_drug_names];

    if (pharmacyId) {
      query += ` AND pharmacy_id = $2`;
      params.push(pharmacyId);
    }

    query += ` RETURNING opportunity_id, recommended_drug_name`;

    const result = await db.query(query, params);

    // Group deleted by recommended_drug_name
    const deletedByType = {};
    result.rows.forEach(r => {
      deletedByType[r.recommended_drug_name] = (deletedByType[r.recommended_drug_name] || 0) + 1;
    });

    logger.info('Unauthorized opportunities cleaned up', {
      totalDeleted: result.rows.length,
      deletedByType,
      performedBy: req.user.userId
    });

    res.json({
      success: true,
      totalDeleted: result.rows.length,
      deletedByType
    });
  } catch (error) {
    logger.error('Cleanup unauthorized opportunities error', { error: error.message });
    res.status(500).json({ error: 'Failed to cleanup unauthorized opportunities' });
  }
});

// Get list of all unauthorized opportunity types (not matching any trigger)
router.get('/unauthorized/list', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    // Get all trigger recommended_drug values
    const triggers = await db.query(`
      SELECT DISTINCT recommended_drug FROM triggers WHERE is_enabled = true
    `);
    const triggerNames = triggers.rows.map(t => t.recommended_drug);

    // Get all opportunity recommended_drug_name values with counts
    const opps = await db.query(`
      SELECT
        o.recommended_drug_name,
        COUNT(*) as total_count,
        COUNT(DISTINCT o.pharmacy_id) as pharmacy_count,
        ARRAY_AGG(DISTINCT ph.pharmacy_name) as pharmacies,
        MIN(o.created_at) as first_created,
        MAX(o.created_at) as last_created,
        COALESCE(SUM(o.annual_margin_gain), 0) as total_margin
      FROM opportunities o
      JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
      GROUP BY o.recommended_drug_name
      ORDER BY total_count DESC
    `);

    // Filter to only unauthorized (case-insensitive comparison)
    const triggerNamesLower = new Set(triggerNames.map(t => t?.toLowerCase()));
    const unauthorized = opps.rows.filter(
      o => !triggerNamesLower.has(o.recommended_drug_name?.toLowerCase())
    );

    const totalUnauthorized = unauthorized.reduce((sum, u) => sum + parseInt(u.total_count), 0);

    res.json({
      unauthorized,
      totalCount: totalUnauthorized,
      triggerCount: triggerNames.length
    });
  } catch (error) {
    logger.error('Get unauthorized list error', { error: error.message });
    res.status(500).json({ error: 'Failed to get unauthorized opportunities list' });
  }
});

// Get all opportunities for a patient (admin view - no pharmacy restriction)
router.get('/patient/:patientId/opportunities', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { patientId } = req.params;

    const result = await db.query(`
      SELECT
        o.opportunity_id,
        o.opportunity_type,
        o.trigger_type,
        o.current_drug_name,
        o.recommended_drug_name,
        o.status,
        o.potential_margin_gain,
        o.annual_margin_gain,
        o.created_at,
        o.actioned_at,
        ph.pharmacy_name
      FROM opportunities o
      LEFT JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
      WHERE o.patient_id = $1
      ORDER BY o.status = 'Not Submitted' ASC, o.annual_margin_gain DESC NULLS LAST
      LIMIT 50
    `, [patientId]);

    res.json({ opportunities: result.rows });
  } catch (error) {
    logger.error('Get patient opportunities error', { error: error.message });
    res.status(500).json({ error: 'Failed to get patient opportunities' });
  }
});

export default router;
