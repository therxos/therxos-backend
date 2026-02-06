// Opportunity routes for TheRxOS V2
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';
import { formatPatientName, formatPrescriberName } from '../utils/formatters.js';
import { getEquivalencyForDrug } from '../data/equivalency-tables.js';
import { invalidatePharmacy } from '../utils/cache.js';

const router = express.Router();

// Get drug class equivalency table for a given drug name
router.get('/equivalency', authenticateToken, (req, res) => {
  const { drug } = req.query;
  if (!drug) {
    return res.status(400).json({ error: 'Drug name required' });
  }
  const result = getEquivalencyForDrug(drug);
  res.json(result);
});

// Get opportunities for authenticated user's pharmacy
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, type, priority, search, sortBy = 'margin', sortOrder = 'desc', limit = 1000, offset = 0 } = req.query;
    const pharmacyId = req.user.pharmacyId;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }

    // Get pharmacy's disabled triggers list
    const settingsResult = await db.query(
      'SELECT settings FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );
    const disabledTriggers = settingsResult.rows[0]?.settings?.disabledTriggers || [];

    // Query using columns that exist in the patients and prescriptions tables
    // Excludes opportunities with pending data quality issues (missing prescriber, unknown drug, etc.)
    // Includes coverage_confidence computed from trigger_bin_values
    let query = `
      SELECT o.*,
        p.patient_hash,
        p.first_name as patient_first_name,
        p.last_name as patient_last_name,
        p.date_of_birth as patient_dob,
        p.chronic_conditions,
        p.primary_insurance_bin,
        p.primary_insurance_pcn,
        p.primary_insurance_group,
        COALESCE(pr.insurance_bin, p.primary_insurance_bin, '') as insurance_bin,
        COALESCE(pr.insurance_group, p.primary_insurance_group, '') as insurance_group,
        pr.contract_id,
        pr.plan_name,
        COALESCE(o.current_drug_name, pr.drug_name) as current_drug,
        COALESCE(o.prescriber_name, pr.prescriber_name) as prescriber_name,
        COALESCE(o.potential_margin_gain, 0) as potential_margin_gain,
        COALESCE(o.potential_margin_gain, 0) * COALESCE(t.annual_fills, 12) as annual_margin_gain,
        CASE
          WHEN o.trigger_id IS NULL THEN NULL
          WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
          WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
          WHEN tbv.verified_claim_count > 0 THEN 'verified'
          WHEN tbv_bin.coverage_status IN ('verified', 'works') THEN 'likely'
          WHEN tbv_bin.verified_claim_count > 0 THEN 'likely'
          ELSE 'unknown'
        END as coverage_confidence,
        COALESCE(tbv.verified_claim_count, tbv_bin.verified_claim_count, 0) as verified_claim_count,
        COALESCE(tbv.avg_reimbursement, tbv_bin.avg_reimbursement) as avg_reimbursement,
        t.category as trigger_category,
        t.expected_qty,
        t.expected_days_supply
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
        AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
        AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
      LEFT JOIN triggers t ON t.trigger_id = o.trigger_id
      LEFT JOIN LATERAL (
        SELECT coverage_status, verified_claim_count, avg_reimbursement
        FROM trigger_bin_values
        WHERE trigger_id = o.trigger_id
          AND insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
          AND (coverage_status IN ('verified', 'works') OR verified_claim_count > 0)
        ORDER BY verified_claim_count DESC NULLS LAST
        LIMIT 1
      ) tbv_bin ON tbv.trigger_id IS NULL
      WHERE o.pharmacy_id = $1
        AND o.patient_id IS NOT NULL
        AND (o.status != 'Not Submitted' OR o.opportunity_id NOT IN (
          SELECT dqi.opportunity_id FROM data_quality_issues dqi
          WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
        ))
        AND (o.status != 'Not Submitted' OR (tbv.is_excluded IS NOT TRUE AND COALESCE(tbv.coverage_status, '') != 'excluded'))
    `;
    const params = [pharmacyId];
    let paramIndex = 2;

    // Filter out disabled triggers
    if (disabledTriggers.length > 0) {
      query += ` AND (o.trigger_id IS NULL OR o.trigger_id != ALL($${paramIndex++}::uuid[]))`;
      params.push(disabledTriggers);
    }

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
      query += ` AND (o.current_drug_name ILIKE $${paramIndex} OR o.recommended_drug_name ILIKE $${paramIndex} OR o.clinical_rationale ILIKE $${paramIndex} OR p.first_name ILIKE $${paramIndex} OR p.last_name ILIKE $${paramIndex})`;
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

    query += ` ORDER BY ${sortColumn} ${sortOrder === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    // Get counts by status (excluding data quality issues, excluded coverage, and disabled triggers)
    const countsParams = [pharmacyId];
    let countsExtra = '';
    if (disabledTriggers.length > 0) {
      countsExtra = ' AND (o.trigger_id IS NULL OR o.trigger_id != ALL($2::uuid[]))';
      countsParams.push(disabledTriggers);
    }
    const countsResult = await db.query(`
      SELECT
        o.status,
        COUNT(*) as count,
        SUM(o.potential_margin_gain) as total_margin,
        SUM(CASE WHEN (
          o.status != 'Not Submitted'
          OR o.trigger_id IS NULL
          OR tbv.coverage_status IN ('verified', 'works')
          OR COALESCE(tbv.verified_claim_count, 0) > 0
        ) THEN o.potential_margin_gain ELSE 0 END) as verified_margin,
        COUNT(CASE WHEN (
          o.status = 'Not Submitted'
          AND o.trigger_id IS NOT NULL
          AND COALESCE(tbv.coverage_status, '') NOT IN ('verified', 'works')
          AND COALESCE(tbv.verified_claim_count, 0) = 0
        ) THEN 1 END) as unknown_count
      FROM opportunities o
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
        AND tbv.insurance_bin = COALESCE(pr.insurance_bin, p.primary_insurance_bin)
        AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, p.primary_insurance_group, '')
      WHERE o.pharmacy_id = $1
        AND (o.status != 'Not Submitted' OR o.opportunity_id NOT IN (
          SELECT dqi.opportunity_id FROM data_quality_issues dqi
          WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
        ))
        AND (o.status != 'Not Submitted' OR (tbv.is_excluded IS NOT TRUE AND COALESCE(tbv.coverage_status, '') != 'excluded'))
        ${countsExtra}
      GROUP BY o.status
    `, countsParams);

    const counts = {};
    for (const row of countsResult.rows) {
      counts[row.status] = {
        count: parseInt(row.count),
        totalMargin: parseFloat(row.total_margin) || 0,
        verifiedMargin: parseFloat(row.verified_margin) || 0,
        unknownCount: parseInt(row.unknown_count) || 0
      };
    }

    // Format patient and prescriber names for display
    const formattedOpportunities = result.rows.map(opp => ({
      ...opp,
      patient_name: formatPatientName(opp.patient_first_name, opp.patient_last_name),
      prescriber_name_formatted: formatPrescriberName(opp.prescriber_name)
    }));

    // Group "Not Submitted" opportunities as alternatives only when they genuinely compete
    // Only these trigger types have competing options (pick ONE):
    //   combo_therapy, therapeutic_interchange, formulation_change, ndc_optimization, brand_to_generic
    // Missing therapy triggers are independent clinical needs (patient can need ALL of them)
    const GROUPABLE_TYPES = new Set([
      'combo_therapy', 'therapeutic_interchange', 'formulation_change',
      'ndc_optimization', 'brand_to_generic',
      'Combination Therapy', 'Therapeutic Interchange', 'Formulation Change',
      'NDC Optimization', 'Brand to Generic Change',
      'Combination Therapy - Triple',
    ]);

    const grouped = [];
    const groupMap = new Map(); // key: "patientId|currentDrug|triggerType" -> primary opp index in grouped[]

    for (const opp of formattedOpportunities) {
      const triggerType = opp.opportunity_type || opp.trigger_category;

      // Normalize drug name for grouping: strip special chars, numbers, strength/form
      const rawDrug = (opp.current_drug || opp.current_drug_name || '');
      const currentDrug = rawDrug
        .toLowerCase()
        .replace(/[^a-z\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b(mg|mcg|ml|tab|cap|tablet|capsule|sol|soln|susp|cream|oint|hfa|er|sr|dr|xl|la)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Only group types where alternatives compete — missing_therapy, DME, etc. always show individually
      if (opp.status !== 'Not Submitted' || !triggerType || !currentDrug || !GROUPABLE_TYPES.has(triggerType)) {
        opp.alternatives = [];
        grouped.push(opp);
        continue;
      }

      const groupKey = `${opp.patient_id}|${currentDrug}|${triggerType}`;
      const annualValue = parseFloat(opp.annual_margin_gain) || 0;

      if (groupMap.has(groupKey)) {
        const primaryIdx = groupMap.get(groupKey);
        const primary = grouped[primaryIdx];
        const primaryValue = parseFloat(primary.annual_margin_gain) || 0;

        if (annualValue > primaryValue) {
          // New opp is better - demote current primary to alternative
          primary.alternatives.push({
            opportunity_id: primary.opportunity_id,
            recommended_drug_name: primary.recommended_drug_name,
            potential_margin_gain: primary.potential_margin_gain,
            annual_margin_gain: primary.annual_margin_gain,
            coverage_confidence: primary.coverage_confidence,
            avg_dispensed_qty: primary.avg_dispensed_qty,
          });
          // Replace primary with this opp, keeping existing alternatives
          const existingAlts = primary.alternatives;
          Object.assign(primary, opp);
          primary.alternatives = existingAlts;
        } else {
          // Current primary is better - add new opp as alternative
          primary.alternatives.push({
            opportunity_id: opp.opportunity_id,
            recommended_drug_name: opp.recommended_drug_name,
            potential_margin_gain: opp.potential_margin_gain,
            annual_margin_gain: opp.annual_margin_gain,
            coverage_confidence: opp.coverage_confidence,
            avg_dispensed_qty: opp.avg_dispensed_qty,
          });
        }
      } else {
        opp.alternatives = [];
        groupMap.set(groupKey, grouped.length);
        grouped.push(opp);
      }
    }

    // Sort alternatives by GP descending
    for (const opp of grouped) {
      if (opp.alternatives?.length > 0) {
        opp.alternatives.sort((a, b) => (parseFloat(b.annual_margin_gain) || 0) - (parseFloat(a.annual_margin_gain) || 0));
      }
    }

    res.json({
      opportunities: grouped,
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
        p.patient_hash, p.first_name as patient_first_name, p.last_name as patient_last_name,
        p.chronic_conditions, p.date_of_birth, p.primary_insurance_bin, p.primary_insurance_pcn, p.primary_insurance_group,
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

    const opp = result.rows[0];
    res.json({
      ...opp,
      patient_name: formatPatientName(opp.patient_first_name, opp.patient_last_name),
      prescriber_name_formatted: formatPrescriberName(opp.prescriber_name),
      actions: actions.rows.map(a => ({
        ...a,
        performed_by_name: formatPatientName(a.first_name, a.last_name)
      }))
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

    // Verify ownership (super_admin can update any opportunity)
    let existing;
    if (req.user.role === 'super_admin') {
      existing = await db.query(
        'SELECT * FROM opportunities WHERE opportunity_id = $1',
        [opportunityId]
      );
    } else {
      existing = await db.query(
        'SELECT * FROM opportunities WHERE opportunity_id = $1 AND pharmacy_id = $2',
        [opportunityId, req.user.pharmacyId]
      );
    }

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Opportunity not found' });
    }

    const updates = {};
    const actionType = status;

    if (status) {
      updates.status = status;

      // Always update actioned_at and actioned_by on any status change
      updates.actioned_by = req.user.userId;
      updates.actioned_at = new Date();

      // Additional tracking for specific statuses
      if (status === 'Submitted') {
        updates.reviewed_by = req.user.userId;
        updates.reviewed_at = new Date();
      } else if (status === 'Denied') {
        updates.dismissed_reason = dismissedReason;
      }
    }

    if (staffNotes !== undefined) {
      updates.staff_notes = staffNotes;
    }

    if (actualMarginRealized !== undefined) {
      updates.actual_margin_realized = actualMarginRealized;
    }

    // Always set updated_at
    updates.updated_at = new Date();

    const result = await db.update('opportunities', 'opportunity_id', opportunityId, updates);

    // Auto-exclude BIN+Group when "Didn't Work" is reported
    if (status === "Didn't Work") {
      const opp = existing.rows[0];
      if (opp.trigger_id) {
        try {
          // Look up the BIN and Group from prescription/patient
          const binLookup = await db.query(`
            SELECT COALESCE(pr.insurance_bin, pat.primary_insurance_bin) as bin,
                   COALESCE(pr.insurance_group, pat.primary_insurance_group) as grp
            FROM opportunities o
            LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
            LEFT JOIN patients pat ON pat.patient_id = o.patient_id
            WHERE o.opportunity_id = $1
          `, [opportunityId]);

          const { bin, grp } = binLookup.rows[0] || {};
          if (bin) {
            await db.query(`
              INSERT INTO trigger_bin_values (trigger_id, insurance_bin, insurance_group, is_excluded, coverage_status, verified_at)
              VALUES ($1, $2, $3, true, 'excluded', NOW())
              ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
              DO UPDATE SET is_excluded = true, coverage_status = 'excluded', verified_at = NOW()
            `, [opp.trigger_id, bin, grp || null]);

            logger.info('Auto-excluded BIN+Group from Didn\'t Work', {
              triggerId: opp.trigger_id,
              bin,
              group: grp,
              opportunityId
            });
          }
        } catch (excludeErr) {
          logger.warn('Failed to auto-exclude BIN+Group', { error: excludeErr.message });
        }
      }
    }

    // Log the action (non-blocking, don't fail if logging fails)
    try {
      await db.insert('opportunity_actions', {
        action_id: uuidv4(),
        opportunity_id: opportunityId,
        action_type: actionType || 'updated',
        action_details: JSON.stringify({ updates }),
        performed_by: req.user.userId,
        outcome: 'success'
      });
    } catch (logError) {
      logger.warn('Failed to log opportunity action', { error: logError.message });
    }

    logger.info('Opportunity updated', {
      opportunityId,
      userId: req.user.userId,
      newStatus: status
    });

    // Invalidate cached analytics for this pharmacy
    invalidatePharmacy(existing.rows[0].pharmacy_id);

    res.json(result);
  } catch (error) {
    logger.error('Update opportunity error', { error: error.message, stack: error.stack });
    res.status(500).json({ error: `Failed to update opportunity: ${error.message}` });
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

    // Invalidate cached analytics
    invalidatePharmacy(req.user.pharmacyId);

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

// Get prescriber action counts for warning system
router.get('/prescriber-stats/:prescriberName', authenticateToken, async (req, res) => {
  try {
    const { prescriberName } = req.params;
    const pharmacyId = req.user.pharmacyId;

    if (!pharmacyId) {
      return res.status(400).json({ error: 'No pharmacy associated with user' });
    }

    // Count unique patients with actioned opportunities for this prescriber
    const result = await db.query(`
      SELECT
        COUNT(DISTINCT o.patient_id) as unique_patients_actioned,
        COUNT(*) as total_opps_actioned
      FROM opportunities o
      WHERE o.pharmacy_id = $1
        AND LOWER(o.prescriber_name) = LOWER($2)
        AND o.status IN ('Submitted', 'Approved', 'Completed')
    `, [pharmacyId, prescriberName]);

    // Get pharmacy threshold settings
    const settingsResult = await db.query(
      'SELECT settings FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );

    const settings = settingsResult.rows[0]?.settings || {};
    const warnThreshold = settings.prescriberWarnThreshold || 15;
    const blockThreshold = settings.prescriberBlockThreshold || null; // null = no block

    res.json({
      prescriberName,
      uniquePatientsActioned: parseInt(result.rows[0]?.unique_patients_actioned || 0),
      totalOppsActioned: parseInt(result.rows[0]?.total_opps_actioned || 0),
      warnThreshold,
      blockThreshold,
      shouldWarn: parseInt(result.rows[0]?.unique_patients_actioned || 0) >= warnThreshold,
      shouldBlock: blockThreshold ? parseInt(result.rows[0]?.unique_patients_actioned || 0) >= blockThreshold : false
    });
  } catch (error) {
    logger.error('Get prescriber stats error', { error: error.message });
    res.status(500).json({ error: 'Failed to get prescriber stats' });
  }
});

// Get opportunity summary/stats
router.get('/summary/stats', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;
    const { days = 30 } = req.query;

    // Exclude opportunities with pending data quality issues from stats
    const stats = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'Not Submitted') as new_count,
        COUNT(*) FILTER (WHERE status = 'reviewed') as reviewed_count,
        COUNT(*) FILTER (WHERE status = 'actioned') as actioned_count,
        COUNT(*) FILTER (WHERE status = 'dismissed') as dismissed_count,
        COALESCE(SUM(potential_margin_gain) FILTER (WHERE status = 'Not Submitted'), 0) as new_margin,
        COALESCE(SUM(actual_margin_realized) FILTER (WHERE status = 'actioned'), 0) as realized_margin,
        COUNT(DISTINCT patient_id) FILTER (WHERE status = 'Not Submitted') as patients_with_opportunities,
        -- Completed stats (all-time, not limited by days)
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Completed'
          AND opportunity_id NOT IN (SELECT dqi.opportunity_id FROM data_quality_issues dqi WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL)
        ) as completed_count,
        (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = $1 AND status = 'Completed'
          AND opportunity_id NOT IN (SELECT dqi.opportunity_id FROM data_quality_issues dqi WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL)
        ) as completed_value,
        -- Approved stats (all-time, not limited by days)
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Approved'
          AND opportunity_id NOT IN (SELECT dqi.opportunity_id FROM data_quality_issues dqi WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL)
        ) as approved_count,
        (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = $1 AND status = 'Approved'
          AND opportunity_id NOT IN (SELECT dqi.opportunity_id FROM data_quality_issues dqi WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL)
        ) as approved_value,
        -- Captured = Approved + Completed (all-time)
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status IN ('Approved', 'Completed')
          AND opportunity_id NOT IN (SELECT dqi.opportunity_id FROM data_quality_issues dqi WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL)
        ) as captured_count,
        (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = $1 AND status IN ('Approved', 'Completed')
          AND opportunity_id NOT IN (SELECT dqi.opportunity_id FROM data_quality_issues dqi WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL)
        ) as captured_value
      FROM opportunities
      WHERE pharmacy_id = $1
        AND created_at >= NOW() - INTERVAL '${parseInt(days)} days'
        AND opportunity_id NOT IN (
          SELECT dqi.opportunity_id FROM data_quality_issues dqi
          WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
        )
    `, [pharmacyId]);

    const byType = await db.query(`
      SELECT
        opportunity_type,
        COUNT(*) as count,
        SUM(potential_margin_gain) as total_margin
      FROM opportunities
      WHERE pharmacy_id = $1
        AND status = 'Not Submitted'
        AND opportunity_id NOT IN (
          SELECT dqi.opportunity_id FROM data_quality_issues dqi
          WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
        )
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
        AND opportunity_id NOT IN (
          SELECT dqi.opportunity_id FROM data_quality_issues dqi
          WHERE dqi.status = 'pending' AND dqi.opportunity_id IS NOT NULL
        )
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
