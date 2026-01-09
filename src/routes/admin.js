// admin.js - Super Admin API routes for platform management
import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import db from '../database/index.js';
import { authenticateToken } from './auth.js';
import { ROLES } from '../utils/permissions.js';

const router = express.Router();

// Middleware to check super admin
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// GET /api/admin/pharmacies - Get all pharmacies with stats
router.get('/pharmacies', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        p.pharmacy_id,
        p.pharmacy_name,
        p.state,
        p.created_at,
        c.client_name,
        c.submitter_email,
        c.status,
        (SELECT COUNT(*) FROM users WHERE pharmacy_id = p.pharmacy_id) as user_count,
        (SELECT COUNT(*) FROM patients WHERE pharmacy_id = p.pharmacy_id) as patient_count,
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = p.pharmacy_id) as opportunity_count,
        (SELECT COALESCE(SUM(annual_margin_gain), 0) FROM opportunities WHERE pharmacy_id = p.pharmacy_id) as total_value,
        (SELECT COALESCE(SUM(annual_margin_gain), 0) FROM opportunities WHERE pharmacy_id = p.pharmacy_id AND status IN ('Completed', 'Approved')) as captured_value,
        (SELECT MAX(updated_at) FROM opportunities WHERE pharmacy_id = p.pharmacy_id) as last_activity
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      ORDER BY p.created_at DESC
    `);
    
    res.json({ pharmacies: result.rows });
  } catch (error) {
    console.error('Error fetching pharmacies:', error);
    res.status(500).json({ error: 'Failed to fetch pharmacies' });
  }
});

// GET /api/admin/stats - Get platform-wide stats
router.get('/stats', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    // Exclude Hero Pharmacy and any demo pharmacies from stats
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM pharmacies WHERE pharmacy_name NOT ILIKE '%hero%' AND pharmacy_name NOT ILIKE '%demo%') as total_pharmacies,
        (SELECT COUNT(*) FROM pharmacies p JOIN clients c ON c.client_id = p.client_id WHERE c.status = 'active' AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as active_pharmacies,
        (SELECT COUNT(*) FROM users u JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as total_users,
        (SELECT COUNT(*) FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as total_opportunities,
        (SELECT COALESCE(SUM(o.annual_margin_gain), 0) FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as total_value,
        (SELECT COALESCE(SUM(o.annual_margin_gain), 0) FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id WHERE o.status IN ('Completed', 'Approved') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as captured_value
    `);

    // Calculate MRR and ARR ($599/mo per active pharmacy)
    const activePharmacies = stats.rows[0]?.active_pharmacies || 0;
    const mrr = activePharmacies * 599;
    const arr = mrr * 12;
    
    res.json({
      ...stats.rows[0],
      mrr,
      arr,
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/admin/impersonate - Login as a pharmacy admin
router.post('/impersonate', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacy_id } = req.body;

    // First get pharmacy info
    const pharmacyResult = await db.query(`
      SELECT p.*, c.client_name, c.client_id
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [pharmacy_id]);

    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    const pharmacy = pharmacyResult.rows[0];

    // Try to find an admin or owner user for this pharmacy
    const userResult = await db.query(`
      SELECT u.*, p.pharmacy_name, c.client_name
      FROM users u
      JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id
      JOIN clients c ON c.client_id = u.client_id
      WHERE u.pharmacy_id = $1 AND u.role IN ('admin', 'owner')
      ORDER BY CASE WHEN u.role = 'owner' THEN 1 ELSE 2 END
      LIMIT 1
    `, [pharmacy_id]);

    let targetUser;
    let isVirtualSession = false;

    if (userResult.rows.length > 0) {
      // Use existing admin/owner
      targetUser = userResult.rows[0];
    } else {
      // Create virtual owner session (no actual user exists)
      isVirtualSession = true;
      targetUser = {
        user_id: `virtual-${pharmacy_id}`,
        email: `admin@${pharmacy.pharmacy_name.toLowerCase().replace(/\s+/g, '')}.virtual`,
        first_name: 'Pharmacy',
        last_name: 'Admin',
        role: 'owner',
        pharmacy_id: pharmacy.pharmacy_id,
        client_id: pharmacy.client_id,
        pharmacy_name: pharmacy.pharmacy_name,
        client_name: pharmacy.client_name,
      };
    }

    // Create impersonation token
    const token = jwt.sign(
      {
        userId: targetUser.user_id,
        email: targetUser.email,
        pharmacyId: targetUser.pharmacy_id || pharmacy.pharmacy_id,
        clientId: targetUser.client_id || pharmacy.client_id,
        role: targetUser.role,
        firstName: targetUser.first_name,
        lastName: targetUser.last_name,
        pharmacyName: targetUser.pharmacy_name || pharmacy.pharmacy_name,
        impersonatedBy: req.user.userId,
        isVirtualSession,
      },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }
    );

    // Log impersonation
    console.log(`Super admin ${req.user.email} impersonating ${isVirtualSession ? 'virtual admin' : targetUser.email} at ${pharmacy.pharmacy_name}`);

    res.json({
      token,
      user: {
        userId: targetUser.user_id,
        email: targetUser.email,
        firstName: targetUser.first_name,
        lastName: targetUser.last_name,
        role: targetUser.role,
        pharmacyId: targetUser.pharmacy_id || pharmacy.pharmacy_id,
        clientId: targetUser.client_id || pharmacy.client_id,
        pharmacyName: targetUser.pharmacy_name || pharmacy.pharmacy_name,
        clientName: targetUser.client_name || pharmacy.client_name,
      },
    });
  } catch (error) {
    console.error('Impersonation error:', error);
    res.status(500).json({ error: 'Impersonation failed' });
  }
});

// GET /api/admin/pharmacy/:id - Get detailed pharmacy info
router.get('/pharmacy/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get pharmacy details
    const pharmacy = await db.query(`
      SELECT p.*, c.client_name, c.submitter_email, c.status, c.stripe_customer_id
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [id]);
    
    if (pharmacy.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }
    
    // Get users
    const users = await db.query(`
      SELECT user_id, email, first_name, last_name, role, is_active, created_at, last_login
      FROM users WHERE pharmacy_id = $1
    `, [id]);
    
    // Get recent activity
    const activity = await db.query(`
      SELECT 
        'opportunity_updated' as type,
        opportunity_id as id,
        status,
        updated_at
      FROM opportunities
      WHERE pharmacy_id = $1
      ORDER BY updated_at DESC
      LIMIT 20
    `, [id]);
    
    res.json({
      pharmacy: pharmacy.rows[0],
      users: users.rows,
      activity: activity.rows,
    });
  } catch (error) {
    console.error('Error fetching pharmacy details:', error);
    res.status(500).json({ error: 'Failed to fetch pharmacy details' });
  }
});

// POST /api/admin/create-super-admin - Create a super admin user (one-time setup)
router.post('/create-super-admin', async (req, res) => {
  try {
    const { email, password, secret } = req.body;
    
    // Require a secret key to create super admin
    if (secret !== process.env.SUPER_ADMIN_SECRET) {
      return res.status(403).json({ error: 'Invalid secret' });
    }
    
    const bcrypt = await import('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 12);
    
    // Check if super admin already exists
    const existing = await db.query(
      'SELECT * FROM users WHERE role = $1',
      [ROLES.SUPER_ADMIN]
    );
    
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Super admin already exists' });
    }
    
    const { v4: uuidv4 } = await import('uuid');
    const userId = uuidv4();
    
    await db.query(`
      INSERT INTO users (user_id, email, password_hash, first_name, last_name, role, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, true)
    `, [userId, email, passwordHash, 'Super', 'Admin', ROLES.SUPER_ADMIN]);
    
    res.json({ success: true, message: 'Super admin created' });
  } catch (error) {
    console.error('Error creating super admin:', error);
    res.status(500).json({ error: 'Failed to create super admin' });
  }
});

// GET /api/admin/didnt-work-queue - Get all "Didn't Work" opportunities for super admin
router.get('/didnt-work-queue', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        o.opportunity_id,
        o.opportunity_type,
        o.current_drug_name,
        o.recommended_drug_name,
        o.potential_margin_gain,
        o.annual_margin_gain,
        o.staff_notes,
        o.updated_at,
        p.pharmacy_name,
        p.pharmacy_id,
        pr.insurance_bin,
        pr.insurance_group,
        pr.plan_name,
        pt.first_name as patient_first_name,
        pt.last_name as patient_last_name,
        (
          SELECT COUNT(*)
          FROM opportunities o2
          LEFT JOIN prescriptions pr2 ON pr2.prescription_id = o2.prescription_id
          WHERE o2.opportunity_type = o.opportunity_type
            AND COALESCE(pr2.insurance_group, '') = COALESCE(pr.insurance_group, '')
            AND o2.status NOT IN ('Denied', 'Flagged', 'Didn''t Work')
        ) as affected_count,
        (
          SELECT COALESCE(SUM(o2.annual_margin_gain), 0)
          FROM opportunities o2
          LEFT JOIN prescriptions pr2 ON pr2.prescription_id = o2.prescription_id
          WHERE o2.opportunity_type = o.opportunity_type
            AND COALESCE(pr2.insurance_group, '') = COALESCE(pr.insurance_group, '')
            AND o2.status NOT IN ('Denied', 'Flagged', 'Didn''t Work')
        ) as affected_value
      FROM opportunities o
      JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN patients pt ON pt.patient_id = o.patient_id
      WHERE o.status = 'Didn''t Work'
      ORDER BY o.updated_at DESC
    `);

    res.json({ opportunities: result.rows });
  } catch (error) {
    console.error('Error fetching didnt-work queue:', error);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

// POST /api/admin/fix-group - Fix GP for a trigger/group combo
router.post('/fix-group', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { opportunityType, insuranceGroup, insuranceBin, newGp, opportunityId } = req.body;

    // Mark the original opportunity as resolved
    if (opportunityId) {
      await db.query(`
        UPDATE opportunities
        SET status = 'Denied',
            dismissed_reason = 'Fixed by super admin - GP updated for group',
            updated_at = NOW()
        WHERE opportunity_id = $1
      `, [opportunityId]);
    }

    // TODO: Store the GP fix for future reference
    // For now, just mark related opportunities with updated GP info in notes

    res.json({
      success: true,
      message: `GP fix applied for ${opportunityType} on group ${insuranceGroup}`
    });
  } catch (error) {
    console.error('Error fixing group:', error);
    res.status(500).json({ error: 'Failed to fix group' });
  }
});

// POST /api/admin/exclude-group - Exclude all opportunities for a trigger/group combo
router.post('/exclude-group', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { opportunityType, insuranceGroup, insuranceBin, reason, opportunityId } = req.body;

    // Get count of affected opportunities before updating
    const countResult = await db.query(`
      SELECT COUNT(*) as count
      FROM opportunities o
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      WHERE o.opportunity_type = $1
        AND COALESCE(pr.insurance_group, '') = $2
        AND o.status NOT IN ('Denied', 'Completed', 'Approved')
    `, [opportunityType, insuranceGroup || '']);

    // Deny all opportunities for this trigger/group combo
    const result = await db.query(`
      UPDATE opportunities o
      SET status = 'Denied',
          dismissed_reason = $3,
          updated_at = NOW()
      FROM prescriptions pr
      WHERE pr.prescription_id = o.prescription_id
        AND o.opportunity_type = $1
        AND COALESCE(pr.insurance_group, '') = $2
        AND o.status NOT IN ('Denied', 'Completed', 'Approved')
      RETURNING o.opportunity_id
    `, [opportunityType, insuranceGroup || '', reason || `Excluded by super admin: ${opportunityType} doesn't work on ${insuranceGroup}`]);

    // Also update the original opportunity if it was a "Didn't Work" one
    if (opportunityId) {
      await db.query(`
        UPDATE opportunities
        SET status = 'Denied',
            dismissed_reason = $1,
            updated_at = NOW()
        WHERE opportunity_id = $2
      `, [reason || `Excluded by super admin`, opportunityId]);
    }

    res.json({
      success: true,
      excluded: result.rows.length,
      totalAffected: parseInt(countResult.rows[0].count),
      message: `Excluded ${result.rows.length} opportunities for ${opportunityType} on group ${insuranceGroup}`
    });
  } catch (error) {
    console.error('Error excluding group:', error);
    res.status(500).json({ error: 'Failed to exclude group' });
  }
});

// POST /api/admin/flag-group - Flag all opportunities for a trigger/group combo (hide until fixed)
router.post('/flag-group', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { opportunityType, insuranceGroup, opportunityId } = req.body;

    // Flag all opportunities for this trigger/group combo
    const result = await db.query(`
      UPDATE opportunities o
      SET status = 'Flagged',
          staff_notes = COALESCE(staff_notes, '') || ' [Auto-flagged: ' || $1 || ' on ' || $2 || ' needs review]',
          flagged_by = $4,
          flagged_at = NOW(),
          updated_at = NOW()
      FROM prescriptions pr
      WHERE pr.prescription_id = o.prescription_id
        AND o.opportunity_type = $1
        AND COALESCE(pr.insurance_group, '') = $2
        AND o.status NOT IN ('Denied', 'Completed', 'Approved', 'Flagged', 'Didn''t Work')
      RETURNING o.opportunity_id
    `, [opportunityType, insuranceGroup || '', opportunityId, req.user.userId]);

    res.json({
      success: true,
      flagged: result.rows.length,
      message: `Flagged ${result.rows.length} opportunities for ${opportunityType} on group ${insuranceGroup}`
    });
  } catch (error) {
    console.error('Error flagging group:', error);
    res.status(500).json({ error: 'Failed to flag group' });
  }
});

// POST /api/admin/resolve-didnt-work - Resolve a single "Didn't Work" opportunity
router.post('/resolve-didnt-work', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { opportunityId, action, reason } = req.body;

    let newStatus = 'Denied';
    if (action === 'reopen') {
      newStatus = 'Not Submitted';
    }

    await db.query(`
      UPDATE opportunities
      SET status = $1,
          dismissed_reason = $2,
          updated_at = NOW()
      WHERE opportunity_id = $3
    `, [newStatus, reason, opportunityId]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error resolving opportunity:', error);
    res.status(500).json({ error: 'Failed to resolve opportunity' });
  }
});


// ===========================================
// TRIGGER MANAGEMENT ENDPOINTS
// ===========================================

// GET /api/admin/triggers - List all triggers with BIN values
router.get('/triggers', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { type, enabled, search } = req.query;

    let query = `
      SELECT
        t.*,
        (SELECT json_agg(json_build_object(
          'bin', tbv.insurance_bin,
          'gpValue', tbv.gp_value,
          'isExcluded', tbv.is_excluded
        )) FROM trigger_bin_values tbv WHERE tbv.trigger_id = t.trigger_id) as bin_values,
        (SELECT json_agg(json_build_object(
          'type', tr.restriction_type,
          'bin', tr.insurance_bin,
          'groups', tr.insurance_groups
        )) FROM trigger_restrictions tr WHERE tr.trigger_id = t.trigger_id) as restrictions
      FROM triggers t
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (type) {
      query += ` AND t.trigger_type = $${paramIndex++}`;
      params.push(type);
    }

    if (enabled !== undefined) {
      query += ` AND t.is_enabled = $${paramIndex++}`;
      params.push(enabled === 'true');
    }

    if (search) {
      query += ` AND (t.display_name ILIKE $${paramIndex} OR t.trigger_code ILIKE $${paramIndex} OR t.category ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    query += ` ORDER BY t.trigger_type, t.display_name`;

    const result = await db.query(query, params);

    // Get counts by type
    const typeCountsResult = await db.query(`
      SELECT trigger_type, COUNT(*) as count
      FROM triggers
      GROUP BY trigger_type
    `);
    const byType = {};
    typeCountsResult.rows.forEach(r => { byType[r.trigger_type] = parseInt(r.count); });

    res.json({
      triggers: result.rows,
      total: result.rows.length,
      byType
    });
  } catch (error) {
    console.error('Error fetching triggers:', error);
    res.status(500).json({ error: 'Failed to fetch triggers' });
  }
});

// GET /api/admin/triggers/:id - Get single trigger with all details
router.get('/triggers/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const triggerResult = await db.query(`
      SELECT * FROM triggers WHERE trigger_id = $1
    `, [id]);

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    const binValuesResult = await db.query(`
      SELECT insurance_bin, gp_value, is_excluded
      FROM trigger_bin_values
      WHERE trigger_id = $1
      ORDER BY insurance_bin
    `, [id]);

    const restrictionsResult = await db.query(`
      SELECT restriction_type, insurance_bin, insurance_groups
      FROM trigger_restrictions
      WHERE trigger_id = $1
    `, [id]);

    res.json({
      trigger: triggerResult.rows[0],
      binValues: binValuesResult.rows,
      restrictions: restrictionsResult.rows
    });
  } catch (error) {
    console.error('Error fetching trigger:', error);
    res.status(500).json({ error: 'Failed to fetch trigger' });
  }
});

// POST /api/admin/triggers - Create new trigger
router.post('/triggers', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    // Accept both camelCase and snake_case
    const body = req.body;
    const triggerCode = body.triggerCode || body.trigger_code;
    const displayName = body.displayName || body.display_name;
    const triggerType = body.triggerType || body.trigger_type;
    const category = body.category;
    const detectionKeywords = body.detectionKeywords || body.detection_keywords || [];
    const excludeKeywords = body.excludeKeywords || body.exclude_keywords || [];
    const ifHasKeywords = body.ifHasKeywords || body.if_has_keywords || [];
    const ifNotHasKeywords = body.ifNotHasKeywords || body.if_not_has_keywords || [];
    const recommendedDrug = body.recommendedDrug || body.recommended_drug;
    const recommendedNdc = body.recommendedNdc || body.recommended_ndc;
    const actionInstructions = body.actionInstructions || body.action_instructions;
    const clinicalRationale = body.clinicalRationale || body.clinical_rationale;
    const priority = body.priority || 'medium';
    const annualFills = body.annualFills || body.annual_fills || 12;
    const defaultGpValue = body.defaultGpValue || body.default_gp_value;
    const isEnabled = body.isEnabled !== undefined ? body.isEnabled : (body.is_enabled !== false);
    const binValues = body.binValues || body.bin_values;
    const restrictions = body.restrictions;

    // Insert trigger
    const result = await db.query(`
      INSERT INTO triggers (
        trigger_code, display_name, trigger_type, category,
        detection_keywords, exclude_keywords, if_has_keywords, if_not_has_keywords,
        recommended_drug, recommended_ndc, action_instructions, clinical_rationale,
        priority, annual_fills, default_gp_value, is_enabled
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *
    `, [
      triggerCode, displayName, triggerType, category,
      detectionKeywords, excludeKeywords, ifHasKeywords, ifNotHasKeywords,
      recommendedDrug, recommendedNdc, actionInstructions, clinicalRationale,
      priority, annualFills, defaultGpValue, isEnabled
    ]);

    const triggerId = result.rows[0].trigger_id;

    // Insert BIN values
    if (binValues && binValues.length > 0) {
      for (const bv of binValues) {
        await db.query(`
          INSERT INTO trigger_bin_values (trigger_id, insurance_bin, gp_value, is_excluded)
          VALUES ($1, $2, $3, $4)
        `, [triggerId, bv.bin, bv.gpValue, bv.isExcluded || false]);
      }
    }

    // Insert restrictions
    if (restrictions && restrictions.length > 0) {
      for (const r of restrictions) {
        await db.query(`
          INSERT INTO trigger_restrictions (trigger_id, restriction_type, insurance_bin, insurance_groups)
          VALUES ($1, $2, $3, $4)
        `, [triggerId, r.type, r.bin, r.groups || []]);
      }
    }

    res.json({ trigger: result.rows[0], triggerId });
  } catch (error) {
    console.error('Error creating trigger:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Trigger code already exists' });
    }
    res.status(500).json({ error: 'Failed to create trigger' });
  }
});

// PUT /api/admin/triggers/:id - Update trigger
router.put('/triggers/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Accept both camelCase and snake_case
    const body = req.body;
    const triggerCode = body.triggerCode || body.trigger_code;
    const displayName = body.displayName || body.display_name;
    const triggerType = body.triggerType || body.trigger_type;
    const category = body.category;
    const detectionKeywords = body.detectionKeywords || body.detection_keywords;
    const excludeKeywords = body.excludeKeywords || body.exclude_keywords;
    const ifHasKeywords = body.ifHasKeywords || body.if_has_keywords;
    const ifNotHasKeywords = body.ifNotHasKeywords || body.if_not_has_keywords;
    const recommendedDrug = body.recommendedDrug || body.recommended_drug;
    const recommendedNdc = body.recommendedNdc || body.recommended_ndc;
    const actionInstructions = body.actionInstructions || body.action_instructions;
    const clinicalRationale = body.clinicalRationale || body.clinical_rationale;
    const priority = body.priority;
    const annualFills = body.annualFills || body.annual_fills;
    const defaultGpValue = body.defaultGpValue || body.default_gp_value;
    const isEnabled = body.isEnabled !== undefined ? body.isEnabled : body.is_enabled;
    const binValues = body.binValues || body.bin_values;
    const restrictions = body.restrictions;

    // Update trigger
    const result = await db.query(`
      UPDATE triggers SET
        trigger_code = COALESCE($1, trigger_code),
        display_name = COALESCE($2, display_name),
        trigger_type = COALESCE($3, trigger_type),
        category = COALESCE($4, category),
        detection_keywords = COALESCE($5, detection_keywords),
        exclude_keywords = COALESCE($6, exclude_keywords),
        if_has_keywords = COALESCE($7, if_has_keywords),
        if_not_has_keywords = COALESCE($8, if_not_has_keywords),
        recommended_drug = COALESCE($9, recommended_drug),
        recommended_ndc = $10,
        action_instructions = COALESCE($11, action_instructions),
        clinical_rationale = $12,
        priority = COALESCE($13, priority),
        annual_fills = COALESCE($14, annual_fills),
        default_gp_value = $15,
        is_enabled = COALESCE($16, is_enabled),
        updated_at = NOW()
      WHERE trigger_id = $17
      RETURNING *
    `, [
      triggerCode, displayName, triggerType, category,
      detectionKeywords, excludeKeywords, ifHasKeywords, ifNotHasKeywords,
      recommendedDrug, recommendedNdc, actionInstructions, clinicalRationale,
      priority, annualFills, defaultGpValue, isEnabled, id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    // Update BIN values if provided
    if (binValues !== undefined) {
      await db.query('DELETE FROM trigger_bin_values WHERE trigger_id = $1', [id]);
      for (const bv of binValues) {
        await db.query(`
          INSERT INTO trigger_bin_values (trigger_id, insurance_bin, gp_value, is_excluded)
          VALUES ($1, $2, $3, $4)
        `, [id, bv.bin, bv.gpValue, bv.isExcluded || false]);
      }
    }

    // Update restrictions if provided
    if (restrictions !== undefined) {
      await db.query('DELETE FROM trigger_restrictions WHERE trigger_id = $1', [id]);
      for (const r of restrictions) {
        await db.query(`
          INSERT INTO trigger_restrictions (trigger_id, restriction_type, insurance_bin, insurance_groups)
          VALUES ($1, $2, $3, $4)
        `, [id, r.type, r.bin, r.groups || []]);
      }
    }

    res.json({ trigger: result.rows[0] });
  } catch (error) {
    console.error('Error updating trigger:', error);
    res.status(500).json({ error: 'Failed to update trigger' });
  }
});

// DELETE /api/admin/triggers/:id - Delete trigger
router.delete('/triggers/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      DELETE FROM triggers WHERE trigger_id = $1 RETURNING trigger_id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    res.json({ success: true, deletedId: id });
  } catch (error) {
    console.error('Error deleting trigger:', error);
    res.status(500).json({ error: 'Failed to delete trigger' });
  }
});

// POST /api/admin/triggers/:id/toggle - Toggle trigger enabled/disabled
router.post('/triggers/:id/toggle', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      UPDATE triggers
      SET is_enabled = NOT is_enabled, updated_at = NOW()
      WHERE trigger_id = $1
      RETURNING trigger_id, is_enabled
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    res.json({ triggerId: id, isEnabled: result.rows[0].is_enabled });
  } catch (error) {
    console.error('Error toggling trigger:', error);
    res.status(500).json({ error: 'Failed to toggle trigger' });
  }
});

// POST /api/admin/triggers/:id/bin-values - Add BIN value to trigger
router.post('/triggers/:id/bin-values', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { bin, gpValue, isExcluded } = req.body;

    const result = await db.query(`
      INSERT INTO trigger_bin_values (trigger_id, insurance_bin, gp_value, is_excluded)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (trigger_id, insurance_bin)
      DO UPDATE SET gp_value = $3, is_excluded = $4, updated_at = NOW()
      RETURNING *
    `, [id, bin, gpValue, isExcluded || false]);

    res.json({ binValue: result.rows[0] });
  } catch (error) {
    console.error('Error adding BIN value:', error);
    res.status(500).json({ error: 'Failed to add BIN value' });
  }
});

// DELETE /api/admin/triggers/:id/bin-values/:bin - Remove BIN value from trigger
router.delete('/triggers/:id/bin-values/:bin', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id, bin } = req.params;

    await db.query(`
      DELETE FROM trigger_bin_values WHERE trigger_id = $1 AND insurance_bin = $2
    `, [id, bin]);

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing BIN value:', error);
    res.status(500).json({ error: 'Failed to remove BIN value' });
  }
});


// ===========================================
// AUDIT RULES ENDPOINTS
// ===========================================

// GET /api/admin/audit-rules - List all audit rules
router.get('/audit-rules', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT * FROM audit_rules ORDER BY rule_type, rule_name
    `);

    res.json({ rules: result.rows });
  } catch (error) {
    console.error('Error fetching audit rules:', error);
    res.status(500).json({ error: 'Failed to fetch audit rules' });
  }
});

// GET /api/admin/audit-rules/:id - Get single audit rule
router.get('/audit-rules/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT * FROM audit_rules WHERE rule_id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit rule not found' });
    }

    res.json({ rule: result.rows[0] });
  } catch (error) {
    console.error('Error fetching audit rule:', error);
    res.status(500).json({ error: 'Failed to fetch audit rule' });
  }
});

// POST /api/admin/audit-rules - Create new audit rule
router.post('/audit-rules', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const {
      ruleCode, ruleName, ruleDescription, ruleType,
      drugKeywords, ndcPattern,
      expectedQuantity, minQuantity, maxQuantity, quantityTolerance,
      minDaysSupply, maxDaysSupply,
      allowedDawCodes, hasGenericAvailable,
      gpThreshold, severity, auditRiskScore, isEnabled
    } = req.body;

    const result = await db.query(`
      INSERT INTO audit_rules (
        rule_code, rule_name, rule_description, rule_type,
        drug_keywords, ndc_pattern,
        expected_quantity, min_quantity, max_quantity, quantity_tolerance,
        min_days_supply, max_days_supply,
        allowed_daw_codes, has_generic_available,
        gp_threshold, severity, audit_risk_score, is_enabled
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *
    `, [
      ruleCode, ruleName, ruleDescription, ruleType,
      drugKeywords || [], ndcPattern,
      expectedQuantity, minQuantity, maxQuantity, quantityTolerance || 0.1,
      minDaysSupply, maxDaysSupply,
      allowedDawCodes || [], hasGenericAvailable,
      gpThreshold || 50, severity || 'warning', auditRiskScore, isEnabled !== false
    ]);

    res.json({ rule: result.rows[0] });
  } catch (error) {
    console.error('Error creating audit rule:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Rule code already exists' });
    }
    res.status(500).json({ error: 'Failed to create audit rule' });
  }
});

// PUT /api/admin/audit-rules/:id - Update audit rule
router.put('/audit-rules/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      ruleCode, ruleName, ruleDescription, ruleType,
      drugKeywords, ndcPattern,
      expectedQuantity, minQuantity, maxQuantity, quantityTolerance,
      minDaysSupply, maxDaysSupply,
      allowedDawCodes, hasGenericAvailable,
      gpThreshold, severity, auditRiskScore, isEnabled
    } = req.body;

    const result = await db.query(`
      UPDATE audit_rules SET
        rule_code = COALESCE($1, rule_code),
        rule_name = COALESCE($2, rule_name),
        rule_description = $3,
        rule_type = COALESCE($4, rule_type),
        drug_keywords = COALESCE($5, drug_keywords),
        ndc_pattern = $6,
        expected_quantity = $7,
        min_quantity = $8,
        max_quantity = $9,
        quantity_tolerance = COALESCE($10, quantity_tolerance),
        min_days_supply = $11,
        max_days_supply = $12,
        allowed_daw_codes = COALESCE($13, allowed_daw_codes),
        has_generic_available = $14,
        gp_threshold = COALESCE($15, gp_threshold),
        severity = COALESCE($16, severity),
        audit_risk_score = $17,
        is_enabled = COALESCE($18, is_enabled),
        updated_at = NOW()
      WHERE rule_id = $19
      RETURNING *
    `, [
      ruleCode, ruleName, ruleDescription, ruleType,
      drugKeywords, ndcPattern,
      expectedQuantity, minQuantity, maxQuantity, quantityTolerance,
      minDaysSupply, maxDaysSupply,
      allowedDawCodes, hasGenericAvailable,
      gpThreshold, severity, auditRiskScore, isEnabled, id
    ]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit rule not found' });
    }

    res.json({ rule: result.rows[0] });
  } catch (error) {
    console.error('Error updating audit rule:', error);
    res.status(500).json({ error: 'Failed to update audit rule' });
  }
});

// DELETE /api/admin/audit-rules/:id - Delete audit rule
router.delete('/audit-rules/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      DELETE FROM audit_rules WHERE rule_id = $1 RETURNING rule_id
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit rule not found' });
    }

    res.json({ success: true, deletedId: id });
  } catch (error) {
    console.error('Error deleting audit rule:', error);
    res.status(500).json({ error: 'Failed to delete audit rule' });
  }
});

// POST /api/admin/audit-rules/:id/toggle - Toggle audit rule enabled/disabled
router.post('/audit-rules/:id/toggle', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      UPDATE audit_rules
      SET is_enabled = NOT is_enabled, updated_at = NOW()
      WHERE rule_id = $1
      RETURNING rule_id, is_enabled
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit rule not found' });
    }

    res.json({ ruleId: id, isEnabled: result.rows[0].is_enabled });
  } catch (error) {
    console.error('Error toggling audit rule:', error);
    res.status(500).json({ error: 'Failed to toggle audit rule' });
  }
});

// GET /api/admin/audit-flags - Get audit flags for review
router.get('/audit-flags', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, status, severity, limit = 50 } = req.query;

    let query = `
      SELECT
        af.*,
        p.pharmacy_name,
        ar.rule_name,
        ar.rule_description
      FROM audit_flags af
      LEFT JOIN pharmacies p ON p.pharmacy_id = af.pharmacy_id
      LEFT JOIN audit_rules ar ON ar.rule_id = af.rule_id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (pharmacyId) {
      query += ` AND af.pharmacy_id = $${paramIndex++}`;
      params.push(pharmacyId);
    }

    if (status) {
      query += ` AND af.status = $${paramIndex++}`;
      params.push(status);
    }

    if (severity) {
      query += ` AND af.severity = $${paramIndex++}`;
      params.push(severity);
    }

    query += ` ORDER BY af.flagged_at DESC LIMIT $${paramIndex++}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json({ flags: result.rows });
  } catch (error) {
    console.error('Error fetching audit flags:', error);
    res.status(500).json({ error: 'Failed to fetch audit flags' });
  }
});


// ==========================================
// PHARMACY RESCAN - Scan for new opportunities & audit risks
// ==========================================

// POST /api/admin/pharmacies/:id/rescan - Rescan a pharmacy for opportunities and audit risks
router.post('/pharmacies/:id/rescan', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { id: pharmacyId } = req.params;
  const { scanType = 'all' } = req.body; // 'all', 'opportunities', 'audit'

  try {
    console.log(`Starting rescan for pharmacy ${pharmacyId}, type: ${scanType}`);

    // Verify pharmacy exists
    const pharmacyResult = await db.query(
      'SELECT pharmacy_id, pharmacy_name FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );
    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }
    const pharmacyName = pharmacyResult.rows[0].pharmacy_name;

    // Load all prescriptions for this pharmacy with patient info
    const rxResult = await db.query(`
      SELECT
        r.prescription_id, r.patient_id, r.drug_name, r.ndc,
        r.quantity_dispensed as quantity, r.days_supply,
        r.dispensed_date, r.insurance_bin as bin, r.insurance_pcn as pcn,
        r.insurance_group as group_number,
        COALESCE(r.insurance_pay, 0) + COALESCE(r.patient_pay, 0) - COALESCE(r.acquisition_cost, 0) as gross_profit,
        r.daw_code, r.sig,
        p.first_name as patient_first_name, p.last_name as patient_last_name
      FROM prescriptions r
      JOIN patients p ON p.patient_id = r.patient_id
      WHERE r.pharmacy_id = $1
      ORDER BY r.patient_id, r.dispensed_date DESC
    `, [pharmacyId]);

    const prescriptions = rxResult.rows;
    console.log(`Loaded ${prescriptions.length} prescriptions`);

    // Load enabled triggers
    const triggersResult = await db.query(`
      SELECT t.*,
        COALESCE(
          json_agg(
            json_build_object('bin', tbv.insurance_bin, 'gp_value', tbv.gp_value, 'is_excluded', tbv.is_excluded)
          ) FILTER (WHERE tbv.id IS NOT NULL),
          '[]'
        ) as bin_values
      FROM triggers t
      LEFT JOIN trigger_bin_values tbv ON t.trigger_id = tbv.trigger_id
      WHERE t.is_enabled = true
      GROUP BY t.trigger_id
    `);
    const triggers = triggersResult.rows;
    console.log(`Loaded ${triggers.length} enabled triggers`);

    // Load enabled audit rules
    const auditResult = await db.query('SELECT * FROM audit_rules WHERE is_enabled = true');
    const auditRules = auditResult.rows;
    console.log(`Loaded ${auditRules.length} enabled audit rules`);

    // Get existing opportunities to avoid duplicates
    // Use opportunity_type + current_drug_name as the dedup key
    const existingOppsResult = await db.query(`
      SELECT patient_id, opportunity_type, current_drug_name
      FROM opportunities
      WHERE pharmacy_id = $1
    `, [pharmacyId]);
    const existingOpps = new Set(
      existingOppsResult.rows.map(o => `${o.patient_id}|${o.opportunity_type}|${o.current_drug_name?.toUpperCase()}`)
    );
    console.log(`Found ${existingOpps.size} existing opportunities`);

    // Get existing audit flags to avoid duplicates
    const existingFlagsResult = await db.query(`
      SELECT patient_id, rule_id, drug_name, dispensed_date
      FROM audit_flags
      WHERE pharmacy_id = $1
    `, [pharmacyId]);
    const existingFlags = new Set(
      existingFlagsResult.rows.map(f => `${f.patient_id}|${f.rule_id}|${f.drug_name?.toUpperCase()}|${f.dispensed_date}`)
    );
    console.log(`Found ${existingFlags.size} existing audit flags`);

    // Group prescriptions by patient
    const patientRxMap = new Map();
    for (const rx of prescriptions) {
      if (!patientRxMap.has(rx.patient_id)) {
        patientRxMap.set(rx.patient_id, []);
      }
      patientRxMap.get(rx.patient_id).push(rx);
    }

    let newOpportunities = 0;
    let skippedOpportunities = 0;
    let newAuditFlags = 0;
    let skippedAuditFlags = 0;

    // Scan for opportunities
    if (scanType === 'all' || scanType === 'opportunities') {
      for (const [patientId, patientRxs] of patientRxMap) {
        const patientDrugs = patientRxs.map(rx => rx.drug_name?.toUpperCase() || '');
        const patientBin = patientRxs[0]?.bin;
        const patientGroup = patientRxs[0]?.group_number;

        for (const trigger of triggers) {
          // Check detection keywords
          const detectKeywords = trigger.detection_keywords || [];
          const excludeKeywords = trigger.exclude_keywords || [];
          const ifHasKeywords = trigger.if_has_keywords || [];
          const ifNotHasKeywords = trigger.if_not_has_keywords || [];

          // Find matching drug
          let matchedDrug = null;
          let matchedRx = null;
          for (const rx of patientRxs) {
            const drugUpper = rx.drug_name?.toUpperCase() || '';

            // Check if drug matches detection keywords
            const matchesDetect = detectKeywords.some(kw => drugUpper.includes(kw.toUpperCase()));
            if (!matchesDetect) continue;

            // Check if drug is excluded
            const matchesExclude = excludeKeywords.some(kw => drugUpper.includes(kw.toUpperCase()));
            if (matchesExclude) continue;

            matchedDrug = rx.drug_name;
            matchedRx = rx;
            break;
          }

          if (!matchedDrug) continue;

          // Check IF_HAS condition (patient must have these drugs)
          if (ifHasKeywords.length > 0) {
            const hasRequired = ifHasKeywords.some(kw =>
              patientDrugs.some(d => d.includes(kw.toUpperCase()))
            );
            if (!hasRequired) continue;
          }

          // Check IF_NOT_HAS condition (for missing therapy triggers)
          if (ifNotHasKeywords.length > 0) {
            const hasForbidden = ifNotHasKeywords.some(kw =>
              patientDrugs.some(d => d.includes(kw.toUpperCase()))
            );
            if (hasForbidden) continue; // Patient already has this therapy
          }

          // Get GP value for this BIN
          let gpValue = trigger.default_gp_value || 50;
          const binValues = trigger.bin_values || [];
          const binConfig = binValues.find(bv => bv.bin === patientBin);
          if (binConfig) {
            if (binConfig.is_excluded) continue; // Skip this BIN
            if (binConfig.gp_value) gpValue = binConfig.gp_value;
          }

          // Check if opportunity already exists (using opportunity_type + drug as key)
          const oppKey = `${patientId}|${trigger.trigger_type}|${matchedDrug.toUpperCase()}`;
          if (existingOpps.has(oppKey)) {
            skippedOpportunities++;
            continue;
          }

          // Create new opportunity
          const annualFills = trigger.annual_fills || 12;
          const annualValue = gpValue * annualFills;

          await db.query(`
            INSERT INTO opportunities (
              opportunity_id, pharmacy_id, patient_id, opportunity_type,
              current_drug_name, recommended_drug_name, potential_margin_gain,
              annual_margin_gain, status, clinical_priority, staff_notes
            ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          `, [
            pharmacyId,
            patientId,
            trigger.trigger_type,
            matchedDrug,
            trigger.recommended_drug,
            gpValue,
            annualValue,
            'Not Submitted',
            trigger.priority || 'medium',
            `Auto-detected by rescan on ${new Date().toISOString().split('T')[0]}`
          ]);

          newOpportunities++;
          existingOpps.add(oppKey); // Prevent duplicates within this scan
        }
      }
    }

    // Scan for audit risks
    if (scanType === 'all' || scanType === 'audit') {
      for (const rx of prescriptions) {
        const drugUpper = rx.drug_name?.toUpperCase() || '';

        for (const rule of auditRules) {
          let violation = null;
          let expectedValue = null;
          let actualValue = null;

          // Check if rule applies to this drug
          const drugKeywords = rule.drug_keywords || [];
          if (drugKeywords.length > 0) {
            const matchesDrug = drugKeywords.some(kw => drugUpper.includes(kw.toUpperCase()));
            if (!matchesDrug) continue;
          }

          // Apply rule checks
          switch (rule.rule_type) {
            case 'quantity_mismatch':
              if (rule.expected_quantity && rx.quantity !== null) {
                if (Number(rx.quantity) !== Number(rule.expected_quantity)) {
                  violation = `${rx.drug_name} quantity should be ${rule.expected_quantity}, got ${rx.quantity}`;
                  expectedValue = String(rule.expected_quantity);
                  actualValue = String(rx.quantity);
                }
              }
              break;

            case 'days_supply_mismatch':
              if (rx.days_supply !== null) {
                if (rule.min_days_supply && rx.days_supply < rule.min_days_supply) {
                  violation = `${rx.drug_name} days supply ${rx.days_supply} is below minimum ${rule.min_days_supply}`;
                  expectedValue = `>= ${rule.min_days_supply}`;
                  actualValue = String(rx.days_supply);
                }
                if (rule.max_days_supply && rx.days_supply > rule.max_days_supply) {
                  violation = `${rx.drug_name} days supply ${rx.days_supply} exceeds maximum ${rule.max_days_supply}`;
                  expectedValue = `<= ${rule.max_days_supply}`;
                  actualValue = String(rx.days_supply);
                }
              }
              break;

            case 'daw_violation':
              if (rule.allowed_daw_codes && rule.allowed_daw_codes.length > 0 && rx.daw_code !== null) {
                if (!rule.allowed_daw_codes.includes(String(rx.daw_code))) {
                  violation = `${rx.drug_name} has DAW ${rx.daw_code}, but should be ${rule.allowed_daw_codes.join('/')} (has generic available)`;
                  expectedValue = rule.allowed_daw_codes.join('/');
                  actualValue = String(rx.daw_code);
                }
              }
              break;

            case 'high_gp_risk':
              if (rx.gross_profit !== null && rule.gp_threshold) {
                if (Number(rx.gross_profit) > Number(rule.gp_threshold)) {
                  violation = `${rx.drug_name} has GP $${rx.gross_profit} (above $${rule.gp_threshold} threshold)`;
                  expectedValue = `<= $${rule.gp_threshold}`;
                  actualValue = `$${rx.gross_profit}`;
                }
              }
              break;

            case 'sig_quantity_mismatch':
              // Check if SIG indicates once daily and qty doesn't match days
              const sigUpper = (rx.sig || '').toUpperCase();
              if ((sigUpper.includes('ONCE DAILY') || sigUpper.includes('QD') || sigUpper.includes('1 DAILY'))
                  && rx.quantity && rx.days_supply) {
                const tolerance = rule.quantity_tolerance || 0.1;
                const diff = Math.abs(rx.quantity - rx.days_supply);
                if (diff > rx.days_supply * tolerance) {
                  violation = `${rx.drug_name}: SIG "${rx.sig}" suggests qty should equal days supply. Got qty=${rx.quantity}, days=${rx.days_supply}`;
                  expectedValue = `qty ≈ ${rx.days_supply}`;
                  actualValue = String(rx.quantity);
                }
              }
              break;
          }

          if (!violation) continue;

          // Check if flag already exists
          const flagKey = `${rx.patient_id}|${rule.rule_id}|${drugUpper}|${rx.dispensed_date}`;
          if (existingFlags.has(flagKey)) {
            skippedAuditFlags++;
            continue;
          }

          // Create audit flag
          await db.query(`
            INSERT INTO audit_flags (
              pharmacy_id, patient_id, prescription_id, rule_id,
              rule_type, severity, drug_name, ndc, dispensed_quantity,
              days_supply, daw_code, sig, gross_profit,
              violation_message, expected_value, actual_value,
              status, dispensed_date
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
          `, [
            pharmacyId,
            rx.patient_id,
            rx.prescription_id,
            rule.rule_id,
            rule.rule_type,
            rule.severity,
            rx.drug_name,
            rx.ndc,
            rx.quantity,
            rx.days_supply,
            rx.daw_code,
            rx.sig,
            rx.gross_profit,
            violation,
            expectedValue,
            actualValue,
            'open',
            rx.dispensed_date
          ]);

          newAuditFlags++;
          existingFlags.add(flagKey); // Prevent duplicates within this scan
        }
      }
    }

    console.log(`Rescan complete: ${newOpportunities} new opportunities, ${newAuditFlags} new audit flags`);

    res.json({
      success: true,
      pharmacy: pharmacyName,
      prescriptionsScanned: prescriptions.length,
      patientsScanned: patientRxMap.size,
      triggersUsed: triggers.length,
      auditRulesUsed: auditRules.length,
      results: {
        newOpportunities,
        skippedOpportunities,
        newAuditFlags,
        skippedAuditFlags,
      }
    });

  } catch (error) {
    console.error('Error during rescan:', error);
    res.status(500).json({ error: 'Failed to rescan pharmacy: ' + error.message });
  }
});

// POST /api/admin/clients - Create a new client (super admin only)
router.post('/clients', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const {
      clientName,
      pharmacyName,
      pharmacyNpi,
      pharmacyState,
      adminEmail,
      adminFirstName,
      adminLastName,
      pmsSystem
    } = req.body;

    // Validate required fields
    if (!clientName || !adminEmail) {
      return res.status(400).json({ error: 'Client name and admin email are required' });
    }

    // Generate subdomain from client name
    const subdomain = clientName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .slice(0, 20);

    // Check if subdomain exists
    const existing = await db.query(
      'SELECT client_id FROM clients WHERE dashboard_subdomain = $1',
      [subdomain]
    );

    const finalSubdomain = existing.rows.length > 0
      ? `${subdomain}${Date.now().toString().slice(-4)}`
      : subdomain;

    // Check if email already exists in users
    const existingUser = await db.query(
      'SELECT user_id FROM users WHERE email = $1',
      [adminEmail.toLowerCase()]
    );
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    // Check if email already exists in clients (delete orphans from failed attempts)
    const existingClientResult = await db.query(
      'SELECT client_id FROM clients WHERE submitter_email = $1',
      [adminEmail.toLowerCase()]
    );
    if (existingClientResult.rows.length > 0) {
      // Check if this is an orphan (no pharmacy or user associated)
      const orphanCheck = await db.query(`
        SELECT c.client_id,
          (SELECT COUNT(*) FROM pharmacies WHERE client_id = c.client_id) as pharmacy_count,
          (SELECT COUNT(*) FROM users WHERE client_id = c.client_id) as user_count
        FROM clients c WHERE c.submitter_email = $1
      `, [adminEmail.toLowerCase()]);

      const orphan = orphanCheck.rows[0];
      if (orphan && parseInt(orphan.pharmacy_count) === 0 && parseInt(orphan.user_count) === 0) {
        // Delete orphan client from failed previous attempt
        await db.query('DELETE FROM clients WHERE client_id = $1', [orphan.client_id]);
        console.log('Deleted orphan client:', orphan.client_id);
      } else {
        return res.status(400).json({ error: 'A client with this email already exists' });
      }
    }

    // Generate IDs and password before transaction
    const clientId = uuidv4();
    const pharmacyId = uuidv4();
    const userId = uuidv4();
    const tempPassword = uuidv4().slice(0, 12);
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    // Use transaction helper for atomic operation
    await db.transaction(async (txClient) => {
      // Create client
      await txClient.query(`
        INSERT INTO clients (client_id, client_name, dashboard_subdomain, submitter_email, status, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [clientId, clientName, finalSubdomain, adminEmail.toLowerCase(), 'active']);

      // Create pharmacy (trim state to 2 chars, NPI to 10)
      await txClient.query(`
        INSERT INTO pharmacies (pharmacy_id, client_id, pharmacy_name, pharmacy_npi, state, pms_system, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [
        pharmacyId,
        clientId,
        pharmacyName || clientName,
        pharmacyNpi ? pharmacyNpi.slice(0, 10) : null,
        pharmacyState ? pharmacyState.slice(0, 2).toUpperCase() : null,
        pmsSystem || null
      ]);

      // Create admin user
      await txClient.query(`
        INSERT INTO users (user_id, client_id, pharmacy_id, email, password_hash, first_name, last_name, role, is_active, must_change_password, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      `, [userId, clientId, pharmacyId, adminEmail.toLowerCase(), passwordHash, adminFirstName || 'Admin', adminLastName || '', 'admin', true, true]);
    });

    console.log('New client created by super admin:', { clientId, clientName, pharmacyId });

    res.status(201).json({
      success: true,
      client: {
        clientId,
        clientName,
        subdomain: finalSubdomain
      },
      pharmacy: {
        pharmacyId,
        pharmacyName: pharmacyName || clientName
      },
      credentials: {
        email: adminEmail.toLowerCase(),
        temporaryPassword: tempPassword
      }
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({ error: 'Failed to create client: ' + error.message });
  }
});


export default router;
