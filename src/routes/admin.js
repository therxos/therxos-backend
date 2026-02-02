// admin.js - Super Admin API routes for platform management
import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { cached, invalidate as invalidateCache } from '../utils/cache.js';
import { authenticateToken } from './auth.js';
import { ROLES } from '../utils/permissions.js';
import auditScanner from '../services/audit-scanner.js';
import { generateOnboardingDocuments } from '../services/documentGenerator.js';
import { sendWelcomeEmail } from '../services/emailService.js';
import { generateClinicalJustification, generateJustificationsForTriggers } from '../services/clinicalJustificationService.js';

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

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
    // Check if we should include demo pharmacies
    const includeDemo = req.query.includeDemo === 'true';

    const result = await db.query(`
      SELECT
        p.pharmacy_id,
        p.client_id,
        p.pharmacy_name,
        p.pharmacy_npi,
        p.ncpdp,
        p.state,
        p.address,
        p.city,
        p.zip,
        p.phone,
        p.fax,
        p.pms_system,
        p.settings,
        p.created_at,
        p.baa_signed_at,
        p.service_agreement_signed_at,
        c.client_name,
        c.submitter_email,
        c.status,
        c.stripe_customer_id,
        (SELECT COUNT(*) FROM users WHERE pharmacy_id = p.pharmacy_id) as user_count,
        (SELECT COUNT(*) FROM patients WHERE pharmacy_id = p.pharmacy_id) as patient_count,
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = p.pharmacy_id) as opportunity_count,
        (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = p.pharmacy_id) as total_value,
        (SELECT COALESCE(SUM(potential_margin_gain), 0) * 12 FROM opportunities WHERE pharmacy_id = p.pharmacy_id AND status IN ('Completed', 'Approved')) as captured_value,
        (SELECT MAX(updated_at) FROM opportunities WHERE pharmacy_id = p.pharmacy_id) as last_activity,
        (SELECT json_build_object(
          'run_type', pr.run_type,
          'completed_at', pr.completed_at,
          'status', pr.status,
          'summary', pr.summary
        ) FROM poll_runs pr
        WHERE pr.pharmacy_id = p.pharmacy_id
        ORDER BY pr.completed_at DESC NULLS LAST
        LIMIT 1) as last_poll,
        (SELECT MAX(rx.created_at) FROM prescriptions rx WHERE rx.pharmacy_id = p.pharmacy_id) as last_data_received
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      ${includeDemo ? '' : "WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%marvel%'"}
      ORDER BY p.created_at DESC
    `);

    res.json({ pharmacies: result.rows });
  } catch (error) {
    console.error('Error fetching pharmacies:', error);
    res.status(500).json({ error: 'Failed to fetch pharmacies' });
  }
});

// PUT /api/admin/pharmacies/:id - Update pharmacy details
router.put('/pharmacies/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      pharmacyName, pharmacyNpi, ncpdp, state, address, city, zip, phone, fax,
      pmsSystem, status, submitterEmail
    } = req.body;

    // Update pharmacy
    const pharmacyResult = await db.query(`
      UPDATE pharmacies SET
        pharmacy_name = COALESCE($1, pharmacy_name),
        pharmacy_npi = COALESCE($2, pharmacy_npi),
        ncpdp = COALESCE($3, ncpdp),
        state = COALESCE($4, state),
        address = COALESCE($5, address),
        city = COALESCE($6, city),
        zip = COALESCE($7, zip),
        phone = COALESCE($8, phone),
        fax = COALESCE($9, fax),
        pms_system = COALESCE($10, pms_system),
        updated_at = NOW()
      WHERE pharmacy_id = $11
      RETURNING *
    `, [pharmacyName, pharmacyNpi, ncpdp, state, address, city, zip, phone, fax, pmsSystem, id]);

    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    // Update client status if provided
    if (status || submitterEmail) {
      const pharmacy = pharmacyResult.rows[0];
      await db.query(`
        UPDATE clients SET
          status = COALESCE($1, status),
          submitter_email = COALESCE($2, submitter_email),
          updated_at = NOW()
        WHERE client_id = $3
      `, [status, submitterEmail, pharmacy.client_id]);
    }

    // Fetch updated pharmacy with client info
    const result = await db.query(`
      SELECT p.*, c.client_name, c.status, c.submitter_email
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [id]);

    res.json({ pharmacy: result.rows[0] });
  } catch (error) {
    console.error('Error updating pharmacy:', error);
    res.status(500).json({ error: 'Failed to update pharmacy' });
  }
});

// GET /api/admin/stats - Get platform-wide stats (authenticated)
router.get('/stats', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    // Exclude demo-status clients and demo/hero pharmacies from stats
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM pharmacies p JOIN clients c ON c.client_id = p.client_id WHERE c.status NOT IN ('demo', 'cancelled') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as total_pharmacies,
        (SELECT COUNT(*) FROM pharmacies p JOIN clients c ON c.client_id = p.client_id WHERE c.status = 'active' AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as active_pharmacies,
        (SELECT COUNT(*) FROM users u JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id JOIN clients c ON c.client_id = p.client_id WHERE c.status NOT IN ('demo', 'cancelled') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as total_users,
        (SELECT COUNT(*) FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id JOIN clients c ON c.client_id = p.client_id WHERE c.status NOT IN ('demo', 'cancelled') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as total_opportunities,
        (SELECT COALESCE(SUM(o.potential_margin_gain), 0) * 12 FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id JOIN clients c ON c.client_id = p.client_id WHERE c.status NOT IN ('demo', 'cancelled') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as total_value,
        (SELECT COALESCE(SUM(o.potential_margin_gain), 0) * 12 FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id JOIN clients c ON c.client_id = p.client_id WHERE o.status IN ('Completed', 'Approved') AND c.status NOT IN ('demo', 'cancelled') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%') as captured_value,
        (SELECT COUNT(*) FROM data_quality_issues WHERE status = 'pending') as pending_quality_issues,
        (SELECT COALESCE(SUM(o.potential_margin_gain), 0) * 12 FROM opportunities o JOIN data_quality_issues dqi ON dqi.opportunity_id = o.opportunity_id WHERE dqi.status = 'pending') as blocked_margin
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

// GET /api/admin/debug/data-quality - Debug endpoint to check data quality table
router.get('/debug/data-quality', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    // Check if table exists
    const tableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'data_quality_issues'
      ) as table_exists
    `);

    const tableExists = tableCheck.rows[0]?.table_exists;

    if (!tableExists) {
      return res.json({
        tableExists: false,
        message: 'data_quality_issues table does not exist. Run migration 008_data_quality_issues.sql'
      });
    }

    // Check trigger exists
    const triggerCheck = await db.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'trg_check_opportunity_quality'
      ) as trigger_exists
    `);

    // Count issues
    const counts = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'pending') as pending,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
        COUNT(*) FILTER (WHERE status = 'ignored') as ignored
      FROM data_quality_issues
    `);

    // Sample data
    const sample = await db.query(`
      SELECT issue_id, pharmacy_id, issue_type, status, created_at
      FROM data_quality_issues
      ORDER BY created_at DESC
      LIMIT 5
    `);

    res.json({
      tableExists: true,
      triggerExists: triggerCheck.rows[0]?.trigger_exists,
      counts: counts.rows[0],
      sampleIssues: sample.rows
    });
  } catch (error) {
    console.error('Debug data quality error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/debug/statuses - Check opportunity status values
router.get('/debug/statuses', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const statuses = await db.query(`
      SELECT status, COUNT(*) as count
      FROM opportunities
      GROUP BY status
      ORDER BY count DESC
    `);
    res.json({ statuses: statuses.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/debug/opportunity-types - Check all opportunity_type values
router.get('/debug/opportunity-types', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const types = await db.query(`
      SELECT opportunity_type, COUNT(*) as count
      FROM opportunities
      GROUP BY opportunity_type
      ORDER BY count DESC
    `);
    res.json({ types: types.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/debug/recommended-drugs - Check all recommended_drug_name values by pharmacy
router.get('/debug/recommended-drugs', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const drugs = await db.query(`
      SELECT
        p.pharmacy_name,
        o.recommended_drug_name,
        COUNT(*) as count
      FROM opportunities o
      JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
      GROUP BY p.pharmacy_name, o.recommended_drug_name
      ORDER BY p.pharmacy_name, count DESC
    `);
    res.json({ drugs: drugs.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/public-stats - Public stats for main website (no auth required)
router.get('/public-stats', async (req, res) => {
  try {
    // Beta capacity limit
    const BETA_MAX_CAPACITY = 10;

    // Exclude Hero Pharmacy and demo pharmacies from public stats
    // Include both 'active' and 'onboarding' in pharmacies_live count
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM prescriptions pr JOIN pharmacies p ON p.pharmacy_id = pr.pharmacy_id WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%marvel%') as claims_analyzed,
        (SELECT COUNT(*) FROM pharmacies p JOIN clients c ON c.client_id = p.client_id WHERE c.status IN ('active', 'onboarding') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%marvel%') as pharmacies_live,
        (SELECT COUNT(*) FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%marvel%') as opportunities_found,
        (SELECT COALESCE(SUM(o.potential_margin_gain), 0) * 12 FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%marvel%') as profit_identified,
        (SELECT COALESCE(SUM(o.potential_margin_gain), 0) * 12 FROM opportunities o JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id WHERE o.status IN ('Completed', 'Approved') AND p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%marvel%') as profit_captured
    `);

    const data = stats.rows[0];
    const pharmaciesLive = parseInt(data.pharmacies_live) || 0;
    const slotsRemaining = Math.max(0, BETA_MAX_CAPACITY - pharmaciesLive);
    const isBetaFull = pharmaciesLive >= BETA_MAX_CAPACITY;

    // Get category breakdowns (excluding demo pharmacies)
    const categoryStats = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN o.opportunity_type = 'therapeutic_interchange' THEN o.annual_margin_gain ELSE 0 END), 0) as therapeutic,
        COALESCE(SUM(CASE WHEN o.opportunity_type = 'brand_to_generic' THEN o.annual_margin_gain ELSE 0 END), 0) as brand_to_generic,
        COALESCE(SUM(CASE WHEN o.opportunity_type = 'missing_therapy' THEN o.annual_margin_gain ELSE 0 END), 0) as missing_therapy,
        COALESCE(SUM(CASE WHEN o.opportunity_type = 'ndc_optimization' THEN o.annual_margin_gain ELSE 0 END), 0) as ndc_optimization,
        COALESCE(SUM(CASE WHEN o.opportunity_type = 'combo_therapy' THEN o.annual_margin_gain ELSE 0 END), 0) as combo_therapy
      FROM opportunities o
      JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
      WHERE p.pharmacy_name NOT ILIKE '%hero%' AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%marvel%'
    `);
    const categories = categoryStats.rows[0];

    // Format numbers for display
    const formatNumber = (num) => {
      const n = parseInt(num) || 0;
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M+';
      if (n >= 1000) return (n / 1000).toFixed(0) + 'K+';
      return n.toString();
    };

    const formatMoney = (num) => {
      const n = parseFloat(num) || 0;
      if (n >= 1000000) return '$' + (n / 1000000).toFixed(1) + 'M+';
      if (n >= 1000) return '$' + (n / 1000).toFixed(0) + 'K+';
      return '$' + n.toFixed(0);
    };

    res.json({
      claims_analyzed: formatNumber(data.claims_analyzed),
      pharmacies_live: pharmaciesLive,
      opportunities_found: formatNumber(data.opportunities_found),
      profit_identified: formatMoney(data.profit_identified),
      profit_captured: formatMoney(data.profit_captured),
      // Beta capacity info
      beta_max_capacity: BETA_MAX_CAPACITY,
      slots_remaining: slotsRemaining,
      is_beta_full: isBetaFull,
      // Category breakdowns for dashboard
      categories: {
        therapeutic: formatMoney(categories.therapeutic),
        brand_to_generic: formatMoney(categories.brand_to_generic),
        missing_therapy: formatMoney(categories.missing_therapy),
        ndc_optimization: formatMoney(categories.ndc_optimization),
        combo_therapy: formatMoney(categories.combo_therapy),
        raw: {
          therapeutic: parseFloat(categories.therapeutic) || 0,
          brand_to_generic: parseFloat(categories.brand_to_generic) || 0,
          missing_therapy: parseFloat(categories.missing_therapy) || 0,
          ndc_optimization: parseFloat(categories.ndc_optimization) || 0,
          combo_therapy: parseFloat(categories.combo_therapy) || 0,
        }
      },
      // Raw values for custom formatting
      raw: {
        claims_analyzed: parseInt(data.claims_analyzed) || 0,
        pharmacies_live: pharmaciesLive,
        opportunities_found: parseInt(data.opportunities_found) || 0,
        profit_identified: parseFloat(data.profit_identified) || 0,
        profit_captured: parseFloat(data.profit_captured) || 0
      }
    });
  } catch (error) {
    console.error('Error fetching public stats:', error);
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

    // Try to find an admin user for this pharmacy
    const userResult = await db.query(`
      SELECT u.*, p.pharmacy_name, c.client_name
      FROM users u
      JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id
      JOIN clients c ON c.client_id = u.client_id
      WHERE u.pharmacy_id = $1 AND u.role = 'admin'
      LIMIT 1
    `, [pharmacy_id]);

    let targetUser;
    let isVirtualSession = false;

    if (userResult.rows.length > 0) {
      // Use existing admin
      targetUser = userResult.rows[0];
    } else {
      // Create virtual admin session (no actual user exists)
      isVirtualSession = true;
      targetUser = {
        user_id: `virtual-${pharmacy_id}`,
        email: `admin@${pharmacy.pharmacy_name.toLowerCase().replace(/\s+/g, '')}.virtual`,
        first_name: 'Pharmacy',
        last_name: 'Admin',
        role: 'admin',
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
        o.opportunity_type as trigger_group,
        o.current_drug_name,
        o.recommended_drug_name,
        o.annual_margin_gain,
        o.staff_notes,
        o.updated_at,
        o.trigger_id,
        p.pharmacy_name,
        p.pharmacy_id,
        COALESCE(pr.insurance_bin, recent_rx.insurance_bin, 'CASH') as insurance_bin,
        COALESCE(pr.insurance_group, recent_rx.insurance_group) as insurance_group,
        COALESCE(pr.plan_name, recent_rx.plan_name) as plan_name,
        pt.first_name as patient_first_name,
        pt.last_name as patient_last_name,
        CASE
          WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
          WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
          WHEN tbv.verified_claim_count > 0 THEN 'verified'
          WHEN tbv_bin.coverage_status IN ('verified', 'works') THEN 'likely'
          WHEN tbv_bin.verified_claim_count > 0 THEN 'likely'
          ELSE 'unknown'
        END as coverage_confidence,
        (
          SELECT COUNT(*)
          FROM opportunities o2
          LEFT JOIN prescriptions pr2 ON pr2.prescription_id = o2.prescription_id
          WHERE o2.opportunity_type = o.opportunity_type
            AND COALESCE(pr2.insurance_group, '') = COALESCE(COALESCE(pr.insurance_group, recent_rx.insurance_group), '')
            AND o2.status NOT IN ('Denied', 'Flagged', 'Didn''t Work')
        ) as affected_count,
        (
          SELECT COALESCE(SUM(o2.annual_margin_gain), 0)
          FROM opportunities o2
          LEFT JOIN prescriptions pr2 ON pr2.prescription_id = o2.prescription_id
          WHERE o2.opportunity_type = o.opportunity_type
            AND COALESCE(pr2.insurance_group, '') = COALESCE(COALESCE(pr.insurance_group, recent_rx.insurance_group), '')
            AND o2.status NOT IN ('Denied', 'Flagged', 'Didn''t Work')
        ) as affected_value
      FROM opportunities o
      JOIN pharmacies p ON p.pharmacy_id = o.pharmacy_id
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN patients pt ON pt.patient_id = o.patient_id
      LEFT JOIN LATERAL (
        SELECT rx.insurance_bin, rx.insurance_group, rx.plan_name
        FROM prescriptions rx
        WHERE rx.patient_id = o.patient_id
          AND rx.insurance_bin IS NOT NULL
          AND rx.insurance_bin != ''
        ORDER BY rx.dispensed_date DESC NULLS LAST
        LIMIT 1
      ) recent_rx ON true
      LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
        AND tbv.insurance_bin = COALESCE(pr.insurance_bin, recent_rx.insurance_bin)
        AND COALESCE(tbv.insurance_group, '') = COALESCE(COALESCE(pr.insurance_group, recent_rx.insurance_group), '')
      LEFT JOIN LATERAL (
        SELECT coverage_status, verified_claim_count, avg_reimbursement
        FROM trigger_bin_values
        WHERE trigger_id = o.trigger_id
          AND insurance_bin = COALESCE(pr.insurance_bin, recent_rx.insurance_bin)
          AND (coverage_status IN ('verified', 'works') OR verified_claim_count > 0)
        ORDER BY verified_claim_count DESC NULLS LAST
        LIMIT 1
      ) tbv_bin ON tbv.trigger_id IS NULL
      WHERE o.status = 'Didn''t Work'
        AND p.pharmacy_name NOT ILIKE '%hero%'
        AND p.pharmacy_name NOT ILIKE '%demo%'
        AND p.pharmacy_name NOT ILIKE '%marvel%'
      ORDER BY o.updated_at DESC
    `);

    res.json({ opportunities: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching didnt-work queue:', error);
    res.status(500).json({ error: 'Failed to fetch queue', details: error.message });
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
          flagged_by = $3,
          flagged_at = NOW(),
          updated_at = NOW()
      FROM prescriptions pr
      WHERE pr.prescription_id = o.prescription_id
        AND o.opportunity_type = $1
        AND COALESCE(pr.insurance_group, '') = $2
        AND o.status NOT IN ('Denied', 'Completed', 'Approved', 'Flagged', 'Didn''t Work')
      RETURNING o.opportunity_id
    `, [opportunityType, insuranceGroup || '', req.user.userId]);

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
// REFERENCE DATA - Best Reimbursing Drugs Per Class Per BIN
// ===========================================

const DRUG_PATTERNS_REF = {
  statins: /atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin|fluvastatin|pitavastatin|lipitor|crestor|zocor/i,
  ace_inhibitors: /lisinopril|enalapril|ramipril|benazepril|captopril|fosinopril|quinapril|moexipril|perindopril|trandolapril|prinivil|zestril|vasotec|altace/i,
  arbs: /losartan|valsartan|irbesartan|olmesartan|candesartan|telmisartan|azilsartan|cozaar|diovan|avapro/i,
  beta_blockers: /metoprolol|atenolol|carvedilol|bisoprolol|propranolol|nadolol|nebivolol|labetalol|lopressor|toprol|coreg/i,
  ccb: /amlodipine|nifedipine|diltiazem|verapamil|felodipine|nicardipine|norvasc|cardizem|procardia/i,
  thiazides: /hydrochlorothiazide|chlorthalidone|indapamide|metolazone|hctz/i,
  loop_diuretics: /furosemide|bumetanide|torsemide|lasix|bumex/i,
  metformin: /metformin|glucophage|fortamet|glumetza|riomet/i,
  sulfonylureas: /glipizide|glyburide|glimepiride|glucotrol|diabeta|micronase|amaryl/i,
  sglt2: /canagliflozin|dapagliflozin|empagliflozin|ertugliflozin|invokana|farxiga|jardiance|steglatro/i,
  glp1: /semaglutide|liraglutide|dulaglutide|exenatide|ozempic|wegovy|victoza|trulicity|byetta|bydureon/i,
  dpp4: /sitagliptin|saxagliptin|linagliptin|alogliptin|januvia|onglyza|tradjenta|nesina/i,
  insulin: /insulin|novolog|humalog|lantus|levemir|basaglar|tresiba|toujeo|admelog|fiasp/i,
  laba: /salmeterol|formoterol|vilanterol|olodaterol|indacaterol|serevent|foradil/i,
  lama: /tiotropium|umeclidinium|aclidinium|glycopyrrolate|spiriva|incruse|tudorza/i,
  ics: /fluticasone|budesonide|beclomethasone|mometasone|ciclesonide|flovent|pulmicort|qvar|asmanex|alvesco/i,
  ics_laba: /advair|symbicort|breo|dulera|wixela|airduo/i,
  saba: /albuterol|levalbuterol|proair|proventil|ventolin|xopenex/i,
  ssri: /fluoxetine|sertraline|paroxetine|escitalopram|citalopram|fluvoxamine|prozac|zoloft|paxil|lexapro|celexa/i,
  snri: /venlafaxine|duloxetine|desvenlafaxine|levomilnacipran|effexor|cymbalta|pristiq|fetzima/i,
  benzo: /alprazolam|lorazepam|clonazepam|diazepam|temazepam|xanax|ativan|klonopin|valium|restoril/i,
  opioids: /oxycodone|hydrocodone|morphine|fentanyl|tramadol|codeine|hydromorphone|oxycontin|percocet|vicodin|norco|dilaudid/i,
  nsaids: /ibuprofen|naproxen|meloxicam|diclofenac|celecoxib|indomethacin|ketorolac|motrin|advil|aleve|mobic|voltaren|celebrex/i,
  ppi: /omeprazole|esomeprazole|lansoprazole|pantoprazole|rabeprazole|dexlansoprazole|prilosec|nexium|prevacid|protonix|aciphex|dexilant/i,
  thyroid: /levothyroxine|synthroid|levoxyl|tirosint|unithroid|armour thyroid|liothyronine/i,
  bisphosphonates: /alendronate|risedronate|ibandronate|zoledronic|fosamax|actonel|boniva|reclast/i,
  anticoagulants: /warfarin|apixaban|rivaroxaban|dabigatran|edoxaban|coumadin|eliquis|xarelto|pradaxa|savaysa/i,
  glucose_test_strips: /freestyle|onetouch|one touch|contour|accu-chek|accu chek|true metrix|truemetrix|prodigy|relion|embrace|test strip|blood glucose strip/i,
  lancets: /lancet|microlet|unistik/i,
  pen_needles: /pen needle|novofine|novotwist|nano pen|bd nano/i
};

const DRUG_CLASS_LABELS = {
  statins: 'Statins', ace_inhibitors: 'ACE Inhibitors', arbs: 'ARBs',
  beta_blockers: 'Beta Blockers', ccb: 'Calcium Channel Blockers',
  thiazides: 'Thiazide Diuretics', loop_diuretics: 'Loop Diuretics',
  metformin: 'Metformin', sulfonylureas: 'Sulfonylureas',
  sglt2: 'SGLT2 Inhibitors', glp1: 'GLP-1 Agonists', dpp4: 'DPP-4 Inhibitors',
  insulin: 'Insulin', laba: 'LABA Inhalers', lama: 'LAMA Inhalers',
  ics: 'Inhaled Corticosteroids', ics_laba: 'ICS/LABA Combos',
  saba: 'Short-Acting Beta Agonists', ssri: 'SSRIs', snri: 'SNRIs',
  benzo: 'Benzodiazepines', opioids: 'Opioids', nsaids: 'NSAIDs',
  ppi: 'Proton Pump Inhibitors', thyroid: 'Thyroid',
  bisphosphonates: 'Bisphosphonates', anticoagulants: 'Anticoagulants',
  glucose_test_strips: 'Glucose Test Strips', lancets: 'Lancets',
  pen_needles: 'Pen Needles', other: 'Other'
};

function classifyTriggerDrugClass(row) {
  // 1. For ndc_optimization, check detection_keywords for DME
  if (row.trigger_type === 'ndc_optimization') {
    const keywords = (row.detection_keywords || []).join(' ').toLowerCase();
    if (/lancet/i.test(keywords)) return 'lancets';
    if (/test strip|glucose strip|freestyle|contour|accu.chek|true.?metrix/i.test(keywords)) return 'glucose_test_strips';
    if (/pen needle|novofine/i.test(keywords)) return 'pen_needles';
  }
  // 2. Try recommended_drug
  if (row.recommended_drug) {
    for (const [cls, pattern] of Object.entries(DRUG_PATTERNS_REF)) {
      if (pattern.test(row.recommended_drug)) return cls;
    }
  }
  // 3. Try display_name
  if (row.display_name) {
    for (const [cls, pattern] of Object.entries(DRUG_PATTERNS_REF)) {
      if (pattern.test(row.display_name)) return cls;
    }
  }
  return 'other';
}

// GET /api/admin/reference-data - Best reimbursing drugs per class per BIN/Group
router.get('/reference-data', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { minGp = 0, minClaims = 1, bin, group, class: drugClassFilter } = req.query;

    let query = `
      SELECT
        t.trigger_id, t.display_name, t.trigger_type, t.category,
        t.recommended_drug, t.recommended_ndc, t.detection_keywords,
        tbv.insurance_bin, tbv.insurance_group, tbv.gp_value,
        tbv.avg_qty, tbv.verified_claim_count, tbv.coverage_status,
        tbv.best_drug_name, tbv.best_ndc, tbv.verified_at
      FROM trigger_bin_values tbv
      JOIN triggers t ON t.trigger_id = tbv.trigger_id
      WHERE t.is_enabled = true
        AND tbv.coverage_status IN ('verified', 'works')
        AND tbv.gp_value IS NOT NULL
        AND tbv.gp_value > $1
        AND COALESCE(tbv.verified_claim_count, 0) >= $2
        AND tbv.insurance_bin NOT LIKE 'MEDICARE:%'
    `;
    const params = [parseFloat(minGp), parseInt(minClaims)];
    let paramIndex = 3;

    if (bin) {
      query += ` AND tbv.insurance_bin = $${paramIndex++}`;
      params.push(bin);
    }
    if (group) {
      query += ` AND tbv.insurance_group = $${paramIndex++}`;
      params.push(group);
    }

    query += ` ORDER BY tbv.gp_value DESC`;

    const result = await db.query(query, params);

    // Group by drug class
    const byClass = {};
    for (const row of result.rows) {
      const drugClass = classifyTriggerDrugClass(row);
      if (drugClassFilter && drugClass !== drugClassFilter) continue;

      if (!byClass[drugClass]) {
        byClass[drugClass] = {
          drugClassLabel: DRUG_CLASS_LABELS[drugClass] || drugClass,
          triggers: {}
        };
      }

      if (!byClass[drugClass].triggers[row.trigger_id]) {
        byClass[drugClass].triggers[row.trigger_id] = {
          triggerId: row.trigger_id,
          displayName: row.display_name,
          recommendedDrug: row.recommended_drug,
          triggerType: row.trigger_type,
          binValues: []
        };
      }

      byClass[drugClass].triggers[row.trigger_id].binValues.push({
        bin: row.insurance_bin,
        group: row.insurance_group,
        gpValue: parseFloat(row.gp_value) || 0,
        avgQty: parseFloat(row.avg_qty) || 0,
        claimCount: parseInt(row.verified_claim_count) || 0,
        bestDrugName: row.best_drug_name,
        bestNdc: row.best_ndc,
        coverageStatus: row.coverage_status,
        verifiedAt: row.verified_at
      });
    }

    // Convert triggers from objects to arrays, compute top formulary
    const topFormulary = [];
    const drugClasses = [];
    let totalTriggers = 0, totalBinGroups = 0, totalClaims = 0;

    for (const [cls, data] of Object.entries(byClass)) {
      data.triggers = Object.values(data.triggers);
      drugClasses.push(cls);
      totalTriggers += data.triggers.length;

      let bestEntry = null;
      for (const trigger of data.triggers) {
        totalBinGroups += trigger.binValues.length;
        totalClaims += trigger.binValues.reduce((s, b) => s + b.claimCount, 0);

        for (const bv of trigger.binValues) {
          if (!bestEntry || bv.gpValue > bestEntry.bestGpValue) {
            bestEntry = {
              drugClass: cls,
              drugClassLabel: data.drugClassLabel,
              bestDrug: bv.bestDrugName || trigger.recommendedDrug || trigger.displayName,
              bestGpValue: bv.gpValue,
              bestBin: bv.bin,
              bestGroup: bv.group
            };
          }
        }
      }

      if (bestEntry) {
        bestEntry.triggerCount = data.triggers.length;
        bestEntry.binGroupCount = data.triggers.reduce((s, t) => s + t.binValues.length, 0);
        bestEntry.totalVerifiedClaims = data.triggers.reduce((s, t) =>
          s + t.binValues.reduce((s2, b) => s2 + b.claimCount, 0), 0);
        topFormulary.push(bestEntry);
      }
    }

    topFormulary.sort((a, b) => a.drugClassLabel.localeCompare(b.drugClassLabel));
    drugClasses.sort((a, b) => (DRUG_CLASS_LABELS[a] || a).localeCompare(DRUG_CLASS_LABELS[b] || b));

    res.json({
      topFormulary,
      byClass,
      drugClasses,
      stats: {
        totalClasses: drugClasses.length,
        totalTriggers,
        totalBinGroups,
        totalVerifiedClaims: totalClaims
      }
    });
  } catch (error) {
    console.error('Error fetching reference data:', error);
    res.status(500).json({ error: 'Failed to fetch reference data: ' + error.message });
  }
});

// ===========================================
// TRIGGER MANAGEMENT ENDPOINTS
// ===========================================

// GET /api/admin/triggers - List all triggers with BIN values
router.get('/triggers', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { type, enabled, search } = req.query;
    const cacheKey = `trigger-coverage:list:${type || 'all'}:${enabled || 'all'}:${search || ''}`;

    const data = await cached(cacheKey, async () => {
    let query = `
      SELECT
        t.*,
        (SELECT json_agg(json_build_object(
          'bin', tbv.insurance_bin,
          'group', tbv.insurance_group,
          'gpValue', tbv.gp_value,
          'isExcluded', tbv.is_excluded,
          'coverageStatus', tbv.coverage_status,
          'verifiedAt', tbv.verified_at,
          'verifiedClaimCount', tbv.verified_claim_count,
          'avgReimbursement', tbv.avg_reimbursement,
          'avgQty', tbv.avg_qty,
          'bestDrugName', tbv.best_drug_name,
          'bestNdc', tbv.best_ndc
        )) FROM trigger_bin_values tbv WHERE tbv.trigger_id = t.trigger_id AND tbv.insurance_bin NOT LIKE 'MEDICARE:%') as bin_values,
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

    // Get per-pharmacy opportunity counts for all triggers
    const pharmacyCountsResult = await db.query(`
      SELECT
        t.trigger_id,
        o.pharmacy_id,
        ph.pharmacy_name,
        COUNT(*) as opportunity_count,
        COUNT(DISTINCT o.patient_id) as patient_count,
        COALESCE(SUM(o.annual_margin_gain), 0) as total_margin
      FROM triggers t
      LEFT JOIN opportunities o ON LOWER(o.recommended_drug_name) = LOWER(t.recommended_drug)
      LEFT JOIN pharmacies ph ON ph.pharmacy_id = o.pharmacy_id
      WHERE o.opportunity_id IS NOT NULL
      GROUP BY t.trigger_id, o.pharmacy_id, ph.pharmacy_name
      ORDER BY t.trigger_id, total_margin DESC
    `);

    // Build a map of trigger_id -> pharmacy stats
    const pharmacyStatsByTrigger = {};
    pharmacyCountsResult.rows.forEach(row => {
      if (!pharmacyStatsByTrigger[row.trigger_id]) {
        pharmacyStatsByTrigger[row.trigger_id] = [];
      }
      pharmacyStatsByTrigger[row.trigger_id].push({
        pharmacy_id: row.pharmacy_id,
        pharmacy_name: row.pharmacy_name,
        opportunity_count: parseInt(row.opportunity_count),
        patient_count: parseInt(row.patient_count),
        total_margin: parseFloat(row.total_margin) || 0
      });
    });

    // Get coverage confidence distribution per trigger
    const confidenceResult = await db.query(`
      SELECT
        o.trigger_id,
        CASE
          WHEN tbv.coverage_status = 'excluded' OR tbv.is_excluded = true THEN 'excluded'
          WHEN tbv.coverage_status IN ('verified', 'works') THEN 'verified'
          WHEN tbv.verified_claim_count > 0 THEN 'verified'
          WHEN tbv_bin.coverage_status IN ('verified', 'works') THEN 'likely'
          WHEN tbv_bin.verified_claim_count > 0 THEN 'likely'
          ELSE 'unknown'
        END as confidence,
        COUNT(*) as cnt
      FROM opportunities o
      LEFT JOIN prescriptions pr ON pr.prescription_id = o.prescription_id
      LEFT JOIN patients pt ON pt.patient_id = o.patient_id
      LEFT JOIN trigger_bin_values tbv ON tbv.trigger_id = o.trigger_id
        AND tbv.insurance_bin = COALESCE(pr.insurance_bin, pt.primary_insurance_bin)
        AND COALESCE(tbv.insurance_group, '') = COALESCE(pr.insurance_group, pt.primary_insurance_group, '')
      LEFT JOIN LATERAL (
        SELECT coverage_status, verified_claim_count, avg_reimbursement
        FROM trigger_bin_values
        WHERE trigger_id = o.trigger_id
          AND insurance_bin = COALESCE(pr.insurance_bin, pt.primary_insurance_bin)
          AND (coverage_status IN ('verified', 'works') OR verified_claim_count > 0)
        ORDER BY verified_claim_count DESC NULLS LAST
        LIMIT 1
      ) tbv_bin ON tbv.trigger_id IS NULL
      WHERE o.trigger_id IS NOT NULL
        AND o.status NOT IN ('Denied', 'Flagged')
      GROUP BY o.trigger_id, confidence
    `);

    // Build confidence map: trigger_id -> { verified: N, likely: N, unknown: N, excluded: N }
    const confidenceByTrigger = {};
    confidenceResult.rows.forEach(row => {
      if (!confidenceByTrigger[row.trigger_id]) {
        confidenceByTrigger[row.trigger_id] = { verified: 0, likely: 0, unknown: 0, excluded: 0 };
      }
      confidenceByTrigger[row.trigger_id][row.confidence] = parseInt(row.cnt);
    });

    // Add pharmacy stats and confidence to each trigger
    const triggersWithStats = result.rows.map(trigger => ({
      ...trigger,
      pharmacy_stats: pharmacyStatsByTrigger[trigger.trigger_id] || [],
      total_opportunities: (pharmacyStatsByTrigger[trigger.trigger_id] || []).reduce((sum, p) => sum + p.opportunity_count, 0),
      total_patients: (pharmacyStatsByTrigger[trigger.trigger_id] || []).reduce((sum, p) => sum + p.patient_count, 0),
      total_margin: (pharmacyStatsByTrigger[trigger.trigger_id] || []).reduce((sum, p) => sum + p.total_margin, 0),
      confidence_distribution: confidenceByTrigger[trigger.trigger_id] || { verified: 0, likely: 0, unknown: 0, excluded: 0 }
    }));

    // Get counts by type
    const typeCountsResult = await db.query(`
      SELECT trigger_type, COUNT(*) as count
      FROM triggers
      GROUP BY trigger_type
    `);
    const byType = {};
    typeCountsResult.rows.forEach(r => { byType[r.trigger_type] = parseInt(r.count); });

    return {
      triggers: triggersWithStats,
      total: result.rows.length,
      byType
    };
    }, 24 * 60 * 60 * 1000); // 24-hour cache

    res.json(data);
  } catch (error) {
    console.error('Error fetching triggers:', error);
    res.status(500).json({ error: 'Failed to fetch triggers', detail: error.message });
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
      SELECT
        id,
        insurance_bin as bin,
        insurance_group as "group",
        gp_value as "gpValue",
        is_excluded as "isExcluded",
        coverage_status as "coverageStatus",
        verified_at as "verifiedAt",
        verified_claim_count as "verifiedClaimCount",
        avg_reimbursement as "avgReimbursement",
        avg_qty as "avgQty",
        created_at as "createdAt",
        updated_at as "updatedAt"
      FROM trigger_bin_values
      WHERE trigger_id = $1
      ORDER BY insurance_bin, COALESCE(insurance_group, '')
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
    let clinicalRationale = body.clinicalRationale || body.clinical_rationale;
    const priority = body.priority || 'medium';
    const annualFills = body.annualFills || body.annual_fills || 12;
    const defaultGpValue = body.defaultGpValue || body.default_gp_value;
    const isEnabled = body.isEnabled !== undefined ? body.isEnabled : (body.is_enabled !== false);
    const binValues = body.binValues || body.bin_values;
    const restrictions = body.restrictions;
    const binInclusions = body.binInclusions || body.bin_inclusions || body.binRestrictions || body.bin_restrictions;
    const binExclusions = body.binExclusions || body.bin_exclusions;
    const groupInclusions = body.groupInclusions || body.group_inclusions;
    const groupExclusions = body.groupExclusions || body.group_exclusions;
    const contractPrefixExclusions = body.contractPrefixExclusions || body.contract_prefix_exclusions;
    const keywordMatchMode = body.keywordMatchMode || body.keyword_match_mode || 'any';
    const pharmacyInclusions = body.pharmacyInclusions || body.pharmacy_inclusions || [];
    const expectedQty = body.expectedQty || body.expected_qty || null;
    const expectedDaysSupply = body.expectedDaysSupply || body.expected_days_supply || null;

    // Auto-generate clinical justification for therapeutic interchanges if not provided
    if (!clinicalRationale && triggerType === 'therapeutic_interchange' && recommendedDrug) {
      try {
        console.log(`Auto-generating clinical justification for new trigger: ${displayName}`);
        clinicalRationale = await generateClinicalJustification({
          display_name: displayName,
          trigger_type: triggerType,
          category,
          detection_keywords: detectionKeywords,
          recommended_drug: recommendedDrug
        });
        console.log(`Generated justification: ${clinicalRationale.substring(0, 100)}...`);
      } catch (genError) {
        console.warn('Failed to auto-generate clinical justification:', genError.message);
        // Continue without justification - not a critical error
      }
    }

    // Insert trigger
    const result = await db.query(`
      INSERT INTO triggers (
        trigger_code, display_name, trigger_type, category,
        detection_keywords, exclude_keywords, if_has_keywords, if_not_has_keywords,
        recommended_drug, recommended_ndc, action_instructions, clinical_rationale,
        priority, annual_fills, default_gp_value, is_enabled, bin_inclusions,
        bin_exclusions, group_inclusions, group_exclusions, contract_prefix_exclusions,
        keyword_match_mode, pharmacy_inclusions, expected_qty, expected_days_supply
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
      RETURNING *
    `, [
      triggerCode, displayName, triggerType, category,
      detectionKeywords, excludeKeywords, ifHasKeywords, ifNotHasKeywords,
      recommendedDrug, recommendedNdc, actionInstructions, clinicalRationale,
      priority, annualFills, defaultGpValue, isEnabled, binInclusions || null,
      binExclusions || null, groupInclusions || null, groupExclusions || null,
      contractPrefixExclusions || null, keywordMatchMode, pharmacyInclusions.length > 0 ? pharmacyInclusions : null,
      expectedQty, expectedDaysSupply
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

    invalidateCache('trigger-coverage:');
    res.json({ trigger: result.rows[0], triggerId });
  } catch (error) {
    console.error('Error creating trigger:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Trigger code already exists' });
    }
    res.status(500).json({ error: 'Failed to create trigger', detail: error.message });
  }
});

// POST /api/admin/triggers/enable-all - Re-enable all disabled triggers
router.post('/triggers/enable-all', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE triggers SET is_enabled = true, updated_at = NOW()
      WHERE is_enabled = false
      RETURNING trigger_id, display_name
    `);
    invalidateCache('trigger-coverage:');
    res.json({ enabled: result.rowCount, triggers: result.rows.map(r => r.display_name) });
  } catch (error) {
    console.error('Error enabling all triggers:', error);
    res.status(500).json({ error: 'Failed to enable triggers' });
  }
});

// POST /api/admin/triggers/scan-all-opportunities - Scan ALL pharmacies for opportunities across ALL enabled triggers
// IMPORTANT: Must be defined before /triggers/:id routes to avoid Express matching "scan-all-opportunities" as :id
router.post('/triggers/scan-all-opportunities', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { daysBack = 90 } = req.body;

    // Get all enabled triggers
    const triggersResult = await db.query(`
      SELECT * FROM triggers WHERE is_enabled = true ORDER BY display_name
    `);
    const triggers = triggersResult.rows;

    // Get all active pharmacies
    const pharmaciesResult = await db.query(`
      SELECT p.pharmacy_id, p.pharmacy_name
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE c.status != 'demo'
    `);
    const pharmacies = pharmaciesResult.rows;

    console.log(`=== SCAN ALL OPPORTUNITIES: ${triggers.length} triggers x ${pharmacies.length} pharmacies ===`);

    let totalCreated = 0;
    let totalSkipped = 0;
    let totalPatientsMatched = 0;
    const triggerResults = [];

    for (const trigger of triggers) {
      const keywords = trigger.detection_keywords || [];
      if (keywords.length === 0) continue;

      // Determine which pharmacies to scan (respect pharmacy_inclusions)
      const pharmacyInclusions = trigger.pharmacy_inclusions || [];
      const targetPharmacies = pharmacyInclusions.length > 0
        ? pharmacies.filter(p => pharmacyInclusions.includes(p.pharmacy_id))
        : pharmacies;

      let triggerCreated = 0;
      let triggerMatched = 0;

      for (const pharmacy of targetPharmacies) {
        // Build keyword patterns
        const keywordPatterns = keywords.map(k => `%${k.toLowerCase()}%`);

        // Parse exclusions
        const binExclusions = (trigger.bin_exclusions || []).map(b => String(b).trim());
        const groupExclusions = trigger.group_exclusions || [];
        const excludeKeywords = trigger.exclude_keywords || [];

        let exclusionConditions = '';
        const exclusionParams = [];
        let paramOffset = keywordPatterns.length + 2;

        if (binExclusions.length > 0) {
          exclusionConditions += ` AND pr.insurance_bin NOT IN (${binExclusions.map((_, i) => `$${paramOffset + i}`).join(', ')})`;
          exclusionParams.push(...binExclusions);
          paramOffset += binExclusions.length;
        }
        if (groupExclusions.length > 0) {
          exclusionConditions += ` AND (pr.insurance_group IS NULL OR pr.insurance_group NOT IN (${groupExclusions.map((_, i) => `$${paramOffset + i}`).join(', ')}))`;
          exclusionParams.push(...groupExclusions);
          paramOffset += groupExclusions.length;
        }

        // Exclude keywords
        let excludeCondition = '';
        if (excludeKeywords.length > 0) {
          const excConds = excludeKeywords.map(ek => {
            exclusionParams.push(ek.toUpperCase());
            return `POSITION($${paramOffset++} IN UPPER(pr.drug_name)) = 0`;
          });
          excludeCondition = ` AND (${excConds.join(' AND ')})`;
        }

        const patientsResult = await db.query(`
          SELECT DISTINCT ON (p.patient_id)
            p.patient_id, p.first_name, p.last_name,
            pr.prescription_id, pr.drug_name as current_drug, pr.ndc as current_ndc,
            pr.prescriber_name, pr.quantity_dispensed,
            pr.insurance_bin as bin, pr.insurance_group as group_number
          FROM patients p
          JOIN prescriptions pr ON pr.patient_id = p.patient_id
          WHERE p.pharmacy_id = $1
            AND pr.dispensed_date >= NOW() - INTERVAL '${daysBack} days'
            AND (${keywordPatterns.map((_, i) => `LOWER(pr.drug_name) LIKE $${i + 2}`).join(' OR ')})
            ${exclusionConditions}
            ${excludeCondition}
          ORDER BY p.patient_id, pr.dispensed_date DESC
        `, [pharmacy.pharmacy_id, ...keywordPatterns, ...exclusionParams]);

        for (const patient of patientsResult.rows) {
          // Check if opportunity already exists
          const existing = await db.query(`
            SELECT 1 FROM opportunities
            WHERE patient_id = $1 AND trigger_id = $2 AND status = 'Not Submitted'
          `, [patient.patient_id, trigger.trigger_id]);

          if (existing.rows.length > 0) {
            totalSkipped++;
            continue;
          }

          // Look up GP from bin values
          const binMatch = await db.query(`
            SELECT gp_value, avg_qty, best_ndc FROM trigger_bin_values
            WHERE trigger_id = $1 AND insurance_bin = $2
              AND COALESCE(insurance_group, '') = COALESCE($3, '')
              AND (is_excluded = false OR is_excluded IS NULL)
            LIMIT 1
          `, [trigger.trigger_id, patient.bin, patient.group_number || null]);

          const gpValue = binMatch.rows[0]?.gp_value || trigger.default_gp_value || 0;
          const avgQty = binMatch.rows[0]?.avg_qty || null;
          const bestNdc = binMatch.rows[0]?.best_ndc || trigger.recommended_ndc || null;
          const annualFills = trigger.annual_fills || 12;

          await db.query(`
            INSERT INTO opportunities (
              opportunity_id, pharmacy_id, patient_id, opportunity_type, trigger_group,
              current_drug_name, current_ndc, recommended_drug_name, recommended_ndc,
              potential_margin_gain, annual_margin_gain, avg_dispensed_qty,
              prescriber_name, trigger_id, clinical_rationale, status, created_at
            ) VALUES (
              gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8,
              ROUND($9::numeric, 2), ROUND(($9 * $10)::numeric, 2), $11,
              $12, $13, $14, 'Not Submitted', NOW()
            )
          `, [
            pharmacy.pharmacy_id, patient.patient_id,
            trigger.trigger_type || 'therapeutic_interchange', trigger.trigger_group,
            patient.current_drug, patient.current_ndc,
            trigger.recommended_drug, bestNdc,
            gpValue, annualFills, avgQty,
            patient.prescriber_name, trigger.trigger_id,
            trigger.clinical_rationale || ''
          ]);

          triggerCreated++;
          totalCreated++;
          triggerMatched++;
        }
      }

      triggerResults.push({
        triggerName: trigger.display_name,
        pharmaciesScanned: targetPharmacies.length,
        opportunitiesCreated: triggerCreated,
        patientsMatched: triggerMatched
      });
    }

    totalPatientsMatched = triggerResults.reduce((sum, r) => sum + r.patientsMatched, 0);

    console.log(`=== SCAN COMPLETE: ${totalCreated} opportunities created, ${totalSkipped} duplicates skipped ===`);
    invalidateCache('trigger-coverage:');

    res.json({
      success: true,
      triggersScanned: triggers.length,
      pharmaciesScanned: pharmacies.length,
      totalCreated,
      totalSkipped,
      totalPatientsMatched,
      triggerResults
    });
  } catch (error) {
    console.error('Scan all opportunities error:', error);
    res.status(500).json({ error: 'Failed to scan opportunities: ' + error.message });
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
    const binInclusions = body.binInclusions || body.bin_inclusions || body.binRestrictions || body.bin_restrictions;
    const binExclusions = body.binExclusions || body.bin_exclusions;
    const groupInclusions = body.groupInclusions || body.group_inclusions;
    const groupExclusions = body.groupExclusions || body.group_exclusions;
    const contractPrefixExclusions = body.contractPrefixExclusions || body.contract_prefix_exclusions;
    const keywordMatchMode = body.keywordMatchMode || body.keyword_match_mode;
    const pharmacyInclusions = body.pharmacyInclusions || body.pharmacy_inclusions;
    const expectedQty = body.expectedQty !== undefined ? body.expectedQty : body.expected_qty;
    const expectedDaysSupply = body.expectedDaysSupply !== undefined ? body.expectedDaysSupply : body.expected_days_supply;

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
        bin_inclusions = $17,
        bin_exclusions = $18,
        group_inclusions = $19,
        group_exclusions = $20,
        contract_prefix_exclusions = $21,
        keyword_match_mode = COALESCE($22, keyword_match_mode),
        pharmacy_inclusions = COALESCE($24, pharmacy_inclusions),
        expected_qty = $25,
        expected_days_supply = $26,
        updated_at = NOW()
      WHERE trigger_id = $23
      RETURNING *
    `, [
      triggerCode, displayName, triggerType, category,
      detectionKeywords, excludeKeywords, ifHasKeywords, ifNotHasKeywords,
      recommendedDrug, recommendedNdc, actionInstructions, clinicalRationale,
      priority, annualFills, defaultGpValue, isEnabled, binInclusions || null,
      binExclusions || null, groupInclusions || null, groupExclusions || null,
      contractPrefixExclusions || null, keywordMatchMode, id,
      pharmacyInclusions || null, expectedQty || null, expectedDaysSupply || null
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

    // Backfill opportunities when annual_fills or default_gp_value changes
    const updatedTrigger = result.rows[0];
    if (annualFills !== undefined || defaultGpValue !== undefined) {
      const backfillResult = await db.query(`
        UPDATE opportunities o SET
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
            ) * COALESCE($3, 12), 2
          ),
          updated_at = NOW()
        WHERE o.trigger_id = $1
          AND o.status = 'Not Submitted'
      `, [id, updatedTrigger.default_gp_value || 0, updatedTrigger.annual_fills || 12]);
      console.log(`Backfilled ${backfillResult.rowCount} opportunities after trigger update (annual_fills: ${updatedTrigger.annual_fills}, default_gp: ${updatedTrigger.default_gp_value})`);
    }

    invalidateCache('trigger-coverage:');
    res.json({ trigger: updatedTrigger });
  } catch (error) {
    console.error('Error updating trigger:', error);
    res.status(500).json({ error: 'Failed to update trigger', detail: error.message });
  }
});

// DELETE /api/admin/triggers/:id - Delete trigger
router.delete('/triggers/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if trigger exists
    const check = await db.query('SELECT trigger_id, display_name FROM triggers WHERE trigger_id = $1', [id]);
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    console.log(`Deleting trigger "${check.rows[0].display_name}" (${id}) - v2 unlink approach`);

    // Unlink actioned opportunities (preserve them, just remove trigger reference)
    const unlinked = await db.query(`
      UPDATE opportunities SET trigger_id = NULL
      WHERE trigger_id = $1 AND status != 'Not Submitted'
    `, [id]);
    if (unlinked.rowCount > 0) {
      console.log(`Unlinked ${unlinked.rowCount} actioned opportunities from trigger ${id}`);
    }

    // Get IDs of unactioned opportunities to delete
    const unactionedOpps = await db.query(`
      SELECT opportunity_id FROM opportunities WHERE trigger_id = $1 AND status = 'Not Submitted'
    `, [id]);
    const oppIds = unactionedOpps.rows.map(r => r.opportunity_id);

    // Clean up FK references that block opportunity deletion
    if (oppIds.length > 0) {
      await db.query('DELETE FROM outreach_queue WHERE opportunity_id = ANY($1::uuid[])', [oppIds]).catch(() => {});
      await db.query('DELETE FROM fax_log WHERE opportunity_id = ANY($1::uuid[])', [oppIds]).catch(() => {});
    }

    // Delete unactioned opportunities linked to this trigger
    const deletedOpps = await db.query(`
      DELETE FROM opportunities WHERE trigger_id = $1 AND status = 'Not Submitted' RETURNING opportunity_id
    `, [id]);

    // Nullify any remaining FK references (pending_opportunity_types, etc.)
    await db.query('UPDATE pending_opportunity_types SET created_trigger_id = NULL WHERE created_trigger_id = $1', [id]).catch(() => {});

    // Now delete the trigger (cascade handles trigger_bin_values and trigger_restrictions)
    const result = await db.query(`
      DELETE FROM triggers WHERE trigger_id = $1 RETURNING trigger_id
    `, [id]);

    invalidateCache('trigger-coverage:');
    res.json({
      success: true,
      deletedId: id,
      triggerName: check.rows[0].display_name,
      opportunitiesRemoved: deletedOpps.rowCount
    });
  } catch (error) {
    console.error('Error deleting trigger:', error);
    res.status(500).json({ error: 'Failed to delete trigger: ' + error.message });
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

    invalidateCache('trigger-coverage:');
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
    const { bin, group, gpValue, isExcluded, coverageStatus } = req.body;

    // Map legacy isExcluded to coverage_status
    let status = coverageStatus || 'unknown';
    if (isExcluded && !coverageStatus) {
      status = 'excluded';
    } else if (!coverageStatus && gpValue) {
      status = 'works';
    }

    const result = await db.query(`
      INSERT INTO trigger_bin_values (trigger_id, insurance_bin, insurance_group, gp_value, is_excluded, coverage_status)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
      DO UPDATE SET
        gp_value = $4,
        is_excluded = $5,
        coverage_status = $6,
        updated_at = NOW()
      RETURNING *
    `, [id, bin, group || null, gpValue, isExcluded || false, status]);

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
    const { group } = req.query; // Optional: delete specific BIN+Group combo

    if (group !== undefined) {
      await db.query(`
        DELETE FROM trigger_bin_values
        WHERE trigger_id = $1 AND insurance_bin = $2 AND COALESCE(insurance_group, '') = $3
      `, [id, bin, group || '']);
    } else {
      await db.query(`
        DELETE FROM trigger_bin_values WHERE trigger_id = $1 AND insurance_bin = $2
      `, [id, bin]);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing BIN value:', error);
    res.status(500).json({ error: 'Failed to remove BIN value' });
  }
});


// ===========================================
// BIN/GROUP DISCOVERY & PRICING ENDPOINTS
// ===========================================

// GET /api/admin/bins - Get available BINs from prescriptions with claim counts
router.get('/bins', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { search, limit = 100 } = req.query;

    let query = `
      SELECT
        insurance_bin as bin,
        COUNT(*) as claim_count,
        COUNT(DISTINCT patient_id) as patient_count,
        COUNT(DISTINCT pharmacy_id) as pharmacy_count,
        AVG(COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0)) as avg_reimbursement
      FROM prescriptions
      WHERE insurance_bin IS NOT NULL AND insurance_bin != ''
    `;
    const params = [];
    let paramIndex = 1;

    if (search) {
      query += ` AND insurance_bin ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }

    query += ` GROUP BY insurance_bin ORDER BY claim_count DESC LIMIT $${paramIndex++}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json({ bins: result.rows });
  } catch (error) {
    console.error('Error fetching BINs:', error);
    res.status(500).json({ error: 'Failed to fetch BINs' });
  }
});

// GET /api/admin/bins/:bin/groups - Get groups for a specific BIN
router.get('/bins/:bin/groups', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { bin } = req.params;
    const { limit = 50 } = req.query;

    const result = await db.query(`
      SELECT
        insurance_group as "group",
        COUNT(*) as claim_count,
        COUNT(DISTINCT patient_id) as patient_count,
        AVG(COALESCE(insurance_pay, 0) + COALESCE(patient_pay, 0)) as avg_reimbursement
      FROM prescriptions
      WHERE insurance_bin = $1 AND insurance_group IS NOT NULL AND insurance_group != ''
      GROUP BY insurance_group
      ORDER BY claim_count DESC
      LIMIT $2
    `, [bin, parseInt(limit)]);

    res.json({ bin, groups: result.rows });
  } catch (error) {
    console.error('Error fetching groups for BIN:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// POST /api/admin/triggers/:id/verify-coverage - Scan for verified coverage
router.post('/triggers/:id/verify-coverage', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id: triggerId } = req.params;
    const { minClaims = 1, daysBack = 365, searchKeywords, minMargin = 10 } = req.body;

    // Get trigger info including bin_inclusions
    const triggerResult = await db.query(
      'SELECT trigger_id, recommended_drug, recommended_ndc, display_name, bin_inclusions, bin_exclusions, group_inclusions, group_exclusions, exclude_keywords, expected_qty, expected_days_supply FROM triggers WHERE trigger_id = $1',
      [triggerId]
    );

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    const trigger = triggerResult.rows[0];
    const recommendedDrug = trigger.recommended_drug || '';
    const binInclusions = (trigger.bin_inclusions || []).map(b => String(b).trim());
    const binExclusions = (trigger.bin_exclusions || []).map(b => String(b).trim());

    console.log(`Verifying coverage for trigger: ${trigger.display_name}, recommended_drug: "${recommendedDrug}", ndc: ${trigger.recommended_ndc || 'none'}, bin_inclusions: ${binInclusions.length > 0 ? binInclusions.join(', ') : 'none'}`);

    // Find matching completed claims from last N days (default 365, configurable via daysBack param)
    let matchQuery;
    let matchParams = [];

    // Determine search terms - priority: request body > trigger field > parse recommended_drug
    let searchTerms = [];

    if (searchKeywords && Array.isArray(searchKeywords) && searchKeywords.length > 0) {
      // Use keywords from request body
      searchTerms = searchKeywords;
    } else if (recommendedDrug) {
      // Parse from recommended_drug - use as single search term
      searchTerms = [recommendedDrug];
    }

    if (searchTerms.length === 0 && !trigger.recommended_ndc) {
      return res.status(400).json({
        error: 'Trigger has no recommended drug, verification keywords, or NDC set',
        trigger: { id: triggerId, name: trigger.display_name }
      });
    }

    // Filter out noise words but KEEP formulation words (tablet, cream, etc.) to prevent cross-formulation matches
    const skipWords = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with'];

    // Build search groups - each term becomes an AND group, groups are OR'd together
    // Example: ["BLOOD PRESSURE MONITOR", "BP MONITOR", "BP CUFF"] becomes:
    // (drug LIKE '%BLOOD%' AND drug LIKE '%PRESSURE%' AND drug LIKE '%MONITOR%')
    // OR (drug LIKE '%BP%' AND drug LIKE '%MONITOR%')
    // OR (drug LIKE '%BP%' AND drug LIKE '%CUFF%')
    const searchGroups = [];
    let paramIndex = 1;

    for (const term of searchTerms) {
      const words = term
        .split(/[\s,.\-\(\)\[\]]+/)
        .map(w => w.trim().toUpperCase())
        .filter(w => w.length >= 2 && !skipWords.includes(w.toLowerCase()) && !/^\d+$/.test(w));

      if (words.length > 0) {
        const groupConditions = words.map(word => {
          matchParams.push(word);
          return `POSITION($${paramIndex++} IN UPPER(drug_name)) > 0`;
        });
        searchGroups.push(`(${groupConditions.join(' AND ')})`);
      }
    }

    console.log(`Using search groups: ${JSON.stringify(searchTerms)} -> ${searchGroups.length} groups, ${matchParams.length} params`);

    const keywordConditions = searchGroups.length > 0 ? searchGroups.join(' OR ') : null;

    // Build exclude_keywords conditions
    let excludeCondition = '';
    const excludeKeywords = trigger.exclude_keywords || [];
    if (excludeKeywords.length > 0) {
      const excludeParts = excludeKeywords.map(kw => {
        const exWords = kw.split(/[\s,.\-\(\)\[\]]+/)
          .map(w => w.trim().toUpperCase())
          .filter(w => w.length >= 2);
        if (exWords.length === 0) return null;
        return '(' + exWords.map(word => {
          matchParams.push(word);
          return `POSITION($${paramIndex++} IN UPPER(drug_name)) > 0`;
        }).join(' AND ') + ')';
      }).filter(Boolean);
      if (excludeParts.length > 0) {
        excludeCondition = `AND NOT (${excludeParts.join(' OR ')})`;
      }
    }

    // Build BIN inclusion/exclusion conditions
    let binRestrictionCondition = '';
    if (binInclusions.length > 0) {
      const idx = matchParams.length + 1;
      matchParams.push(binInclusions);
      binRestrictionCondition += `AND insurance_bin = ANY($${idx})`;
      console.log(`Including only BINs: ${binInclusions.join(', ')}`);
    }
    if (binExclusions.length > 0) {
      const idx = matchParams.length + 1;
      matchParams.push(binExclusions);
      binRestrictionCondition += ` AND insurance_bin != ALL($${idx})`;
      console.log(`Excluding BINs: ${binExclusions.join(', ')}`);
    }

    // Build normalization SQL based on trigger's expected_qty/expected_days_supply
    const DAYS_SUPPLY_EST = `COALESCE(days_supply, CASE WHEN COALESCE(quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(quantity_dispensed,0) > 34 THEN 60 ELSE 30 END)`;
    const GP_SQL_INLINE = `COALESCE(
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
            )`;

    let gpNormSQL, qtyNormSQL, daysFilterSQL;
    if (trigger.expected_qty) {
      const expectedQty = parseFloat(trigger.expected_qty);
      gpNormSQL = `${GP_SQL_INLINE} * (${expectedQty} / GREATEST(COALESCE(quantity_dispensed, ${expectedQty})::numeric, 1))`;
      qtyNormSQL = `${expectedQty}`;
      const minDays = trigger.expected_days_supply ? Math.floor(trigger.expected_days_supply * 0.8) : 20;
      daysFilterSQL = `${DAYS_SUPPLY_EST} >= ${minDays}`;
    } else if (trigger.expected_days_supply) {
      gpNormSQL = `${GP_SQL_INLINE} * (30.0 / GREATEST(${DAYS_SUPPLY_EST}::numeric, 1))`;
      qtyNormSQL = `COALESCE(quantity_dispensed, 1) * (30.0 / GREATEST(${DAYS_SUPPLY_EST}::numeric, 1))`;
      const minDays = Math.floor(trigger.expected_days_supply * 0.8);
      daysFilterSQL = `${DAYS_SUPPLY_EST} >= ${minDays}`;
    } else {
      gpNormSQL = `${GP_SQL_INLINE} / GREATEST(CEIL(${DAYS_SUPPLY_EST}::numeric / 30.0), 1)`;
      qtyNormSQL = `COALESCE(quantity_dispensed, 1) / GREATEST(CEIL(${DAYS_SUPPLY_EST}::numeric / 30.0), 1)`;
      daysFilterSQL = `${DAYS_SUPPLY_EST} >= 28`;
    }

    if (keywordConditions || trigger.recommended_ndc) {
      // Keyword-only matching — do NOT use OR ndc to avoid pulling in wrong formulations
      const minClaimsParamIndex = matchParams.length + 1;
      matchParams.push(parseInt(minClaims));
      const daysBackParamIndex = matchParams.length + 1;
      matchParams.push(parseInt(daysBack));
      const minMarginParamIndex = matchParams.length + 1;
      matchParams.push(parseFloat(minMargin));

      const whereClause = keywordConditions ? `(${keywordConditions})` : 'FALSE';

      matchQuery = `
        WITH raw_claims AS (
          SELECT
            insurance_bin as bin,
            insurance_group as grp,
            drug_name,
            ndc,
            ${gpNormSQL} as gp_30day,
            ${qtyNormSQL} as qty_30day,
            dispensed_date, created_at
          FROM prescriptions
          WHERE ${whereClause}
          ${excludeCondition}
          AND insurance_bin IS NOT NULL AND insurance_bin != ''
          AND ${daysFilterSQL}
          ${binRestrictionCondition}
          AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackParamIndex}
        ),
        per_product AS (
          SELECT
            bin, grp, drug_name, ndc,
            COUNT(*) as claim_count,
            AVG(gp_30day) as avg_reimbursement,
            AVG(qty_30day) as avg_qty,
            MAX(COALESCE(dispensed_date, created_at)) as most_recent_claim,
            ROW_NUMBER() OVER (
              PARTITION BY bin, grp
              ORDER BY AVG(gp_30day) DESC
            ) as rank
          FROM raw_claims
          GROUP BY bin, grp, drug_name, ndc
          HAVING COUNT(*) >= $${minClaimsParamIndex}
            AND AVG(gp_30day) >= $${minMarginParamIndex}
        )
        SELECT bin, grp as "group", drug_name as best_drug, ndc as best_ndc,
               SUM(claim_count) OVER (PARTITION BY bin, grp) as claim_count,
               avg_reimbursement, avg_qty, most_recent_claim
        FROM per_product WHERE rank = 1
        ORDER BY avg_reimbursement DESC
      `;
    } else {
      const minClaimsParamIndex = matchParams.length + 1;
      matchParams.push(parseInt(minClaims));
      const daysBackParamIndex = matchParams.length + 1;
      matchParams.push(parseInt(daysBack));
      const minMarginParamIndex = matchParams.length + 1;
      matchParams.push(parseFloat(minMargin));

      matchQuery = `
        WITH raw_claims AS (
          SELECT
            insurance_bin as bin,
            insurance_group as grp,
            drug_name,
            ndc,
            ${gpNormSQL} as gp_30day,
            ${qtyNormSQL} as qty_30day,
            dispensed_date, created_at
          FROM prescriptions
          WHERE ${keywordConditions ? `(${keywordConditions})` : 'FALSE'}
          ${excludeCondition}
          AND insurance_bin IS NOT NULL AND insurance_bin != ''
          AND ${daysFilterSQL}
          ${binRestrictionCondition}
          AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackParamIndex}
        ),
        per_product AS (
          SELECT
            bin, grp, drug_name, ndc,
            COUNT(*) as claim_count,
            AVG(gp_30day) as avg_reimbursement,
            AVG(qty_30day) as avg_qty,
            MAX(COALESCE(dispensed_date, created_at)) as most_recent_claim,
            ROW_NUMBER() OVER (
              PARTITION BY bin, grp
              ORDER BY AVG(gp_30day) DESC
            ) as rank
          FROM raw_claims
          GROUP BY bin, grp, drug_name, ndc
          HAVING COUNT(*) >= $${minClaimsParamIndex}
            AND AVG(gp_30day) >= $${minMarginParamIndex}
        )
        SELECT bin, grp as "group", drug_name as best_drug, ndc as best_ndc,
               SUM(claim_count) OVER (PARTITION BY bin, grp) as claim_count,
               avg_reimbursement, avg_qty, most_recent_claim
        FROM per_product WHERE rank = 1
        ORDER BY avg_reimbursement DESC
      `;
    }

    const matches = await db.query(matchQuery, matchParams);
    console.log(`Found ${matches.rows.length} BIN/Group combinations for "${recommendedDrug}"`);

    // Clear stale BIN values from previous scans (preserve manually excluded entries)
    await db.query(`
      DELETE FROM trigger_bin_values
      WHERE trigger_id = $1 AND (is_excluded = false OR is_excluded IS NULL)
    `, [triggerId]);

    // Insert into trigger_bin_values with verified status and best drug/NDC
    const verified = [];
    for (const match of matches.rows) {
      const result = await db.query(`
        INSERT INTO trigger_bin_values (
          trigger_id, insurance_bin, insurance_group, coverage_status,
          verified_at, verified_claim_count, avg_reimbursement, avg_qty, gp_value,
          best_drug_name, best_ndc
        )
        VALUES ($1, $2, $3, 'verified', NOW(), $4, $5, $6, $5, $7, $8)
        ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
        DO UPDATE SET
          coverage_status = 'verified',
          verified_at = NOW(),
          verified_claim_count = $4,
          avg_reimbursement = $5,
          avg_qty = $6,
          gp_value = $5,
          best_drug_name = $7,
          best_ndc = $8
        RETURNING *
      `, [
        triggerId,
        match.bin,
        match.group || null,
        parseInt(match.claim_count),
        parseFloat(match.avg_reimbursement) || 0,
        parseFloat(match.avg_qty) || 1,
        match.best_drug || null,
        match.best_ndc || null
      ]);
      verified.push(result.rows[0]);
    }

    console.log(`Verified ${verified.length} BIN/Group combinations for trigger ${trigger.display_name}`);

    // Auto-update trigger's default_gp_value to median GP (not max) for reasonable estimates
    if (verified.length > 0) {
      const gpValues = verified
        .map(v => parseFloat(v.gp_value) || 0)
        .filter(gp => gp > 0)
        .sort((a, b) => a - b);
      const medianGP = gpValues.length > 0
        ? gpValues.length % 2 === 0
          ? (gpValues[gpValues.length / 2 - 1] + gpValues[gpValues.length / 2]) / 2
          : gpValues[Math.floor(gpValues.length / 2)]
        : 0;
      const bestEntry = verified.reduce((best, v) => (parseFloat(v.gp_value) || 0) > (parseFloat(best.gp_value) || 0) ? v : best, verified[0]);

      await db.query(`
        UPDATE triggers SET
          default_gp_value = $1,
          recommended_ndc = COALESCE($2, recommended_ndc),
          synced_at = NOW()
        WHERE trigger_id = $3
      `, [medianGP, bestEntry.best_ndc, triggerId]);

      console.log(`Auto-updated trigger ${trigger.display_name}: default_gp=$${medianGP} (median), recommended_ndc=${bestEntry.best_ndc || 'unchanged'}`);

      // Backfill opportunities: update GP, annual, qty, and NDC for "Not Submitted" opportunities
      const backfillResult = await db.query(`
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
      `, [triggerId, medianGP]);

      console.log(`Backfilled ${backfillResult.rowCount} opportunities with updated GP values`);
    }

    res.json({
      success: true,
      trigger: { id: triggerId, name: trigger.display_name },
      verifiedCount: verified.length,
      entries: verified
    });
  } catch (error) {
    console.error('Error verifying coverage:', error);
    res.status(500).json({ error: 'Failed to verify coverage: ' + error.message });
  }
});

// GET /api/admin/triggers/:id/medicare-data - Get Medicare coverage data for a trigger
router.get('/triggers/:id/medicare-data', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id: triggerId } = req.params;

    // Get trigger info
    const triggerResult = await db.query(
      'SELECT trigger_id, recommended_drug, recommended_ndc, display_name FROM triggers WHERE trigger_id = $1',
      [triggerId]
    );

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    const trigger = triggerResult.rows[0];
    const recommendedDrug = trigger.recommended_drug || '';

    // Parse search words from recommended drug
    const skipWords = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium'];
    const words = recommendedDrug
      .split(/[\s,.\-\(\)\[\]]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length >= 2 && !skipWords.includes(w.toLowerCase()) && !/^\d+$/.test(w));

    if (words.length === 0 && !trigger.recommended_ndc) {
      return res.json({
        trigger: { id: triggerId, name: trigger.display_name },
        medicare: { available: false, reason: 'No recommended drug or NDC' }
      });
    }

    // Build search conditions
    const conditions = words.map((w, i) => `POSITION($${i + 1} IN UPPER(drug_name)) > 0`);
    let params = [...words];

    // Find Medicare claims (BINs starting with 610 are typically Medicare Part D)
    const medicareQuery = `
      SELECT
        contract_id,
        plan_name,
        insurance_bin as bin,
        COUNT(*) as claim_count,
        AVG(COALESCE(
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
            )) as avg_gp,
        AVG(COALESCE((raw_data->>'insurance_pay')::numeric, 0)) as avg_insurance_pay,
        MIN(dispensed_date) as first_claim,
        MAX(dispensed_date) as last_claim
      FROM prescriptions
      WHERE ${conditions.length > 0 ? `(${conditions.join(' AND ')})` : 'FALSE'}
      ${trigger.recommended_ndc ? `OR ndc = $${params.length + 1}` : ''}
      AND insurance_bin LIKE '610%'
      AND contract_id IS NOT NULL
      GROUP BY contract_id, plan_name, insurance_bin
      ORDER BY claim_count DESC
      LIMIT 20
    `;

    if (trigger.recommended_ndc) {
      params.push(trigger.recommended_ndc);
    }

    const medicareResult = await db.query(medicareQuery, params);

    // Get summary stats
    const summaryQuery = `
      SELECT
        COUNT(*) as total_claims,
        COUNT(DISTINCT contract_id) as unique_plans,
        AVG(COALESCE(
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
            )) as avg_gp,
        AVG(COALESCE((raw_data->>'insurance_pay')::numeric, 0)) as avg_insurance_pay
      FROM prescriptions
      WHERE ${conditions.length > 0 ? `(${conditions.join(' AND ')})` : 'FALSE'}
      ${trigger.recommended_ndc ? `OR ndc = $${words.length + 1}` : ''}
      AND insurance_bin LIKE '610%'
      AND contract_id IS NOT NULL
    `;

    const summaryResult = await db.query(summaryQuery, params);
    const summary = summaryResult.rows[0];

    res.json({
      trigger: { id: triggerId, name: trigger.display_name, recommendedDrug },
      medicare: {
        available: parseInt(summary.total_claims) > 0,
        summary: {
          totalClaims: parseInt(summary.total_claims) || 0,
          uniquePlans: parseInt(summary.unique_plans) || 0,
          avgGP: parseFloat(summary.avg_gp) || 0,
          avgInsurancePay: parseFloat(summary.avg_insurance_pay) || 0
        },
        plans: medicareResult.rows.map(r => ({
          contractId: r.contract_id,
          planName: r.plan_name,
          bin: r.bin,
          claimCount: parseInt(r.claim_count),
          avgGP: parseFloat(r.avg_gp) || 0,
          avgInsurancePay: parseFloat(r.avg_insurance_pay) || 0,
          firstClaim: r.first_claim,
          lastClaim: r.last_claim
        }))
      }
    });

  } catch (error) {
    console.error('Error getting Medicare data:', error);
    res.status(500).json({ error: 'Failed to get Medicare data: ' + error.message });
  }
});

// POST /api/admin/triggers/scan-all - Scan ALL triggers for coverage at once
router.post('/triggers/scan-all', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { minClaims = 1, daysBack = 365, minMargin = 0 } = req.body;

    console.log(`=== BULK SCAN ALL TRIGGERS ===`);
    console.log(`minClaims: ${minClaims}, daysBack: ${daysBack}, minMargin: ${minMargin}`);

    // Get all enabled triggers with recommended drugs
    const triggersResult = await db.query(`
      SELECT trigger_id, display_name, recommended_drug, recommended_ndc
      FROM triggers
      WHERE is_enabled = true
      AND (recommended_drug IS NOT NULL AND recommended_drug != '' OR recommended_ndc IS NOT NULL)
      ORDER BY display_name
    `);

    const triggers = triggersResult.rows;
    console.log(`Found ${triggers.length} triggers to scan`);

    const results = [];
    const skipWords = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with'];

    for (const trigger of triggers) {
      const recommendedDrug = trigger.recommended_drug || '';

      // Parse search words
      const words = recommendedDrug
        .split(/[\s,.\-\(\)\[\]]+/)
        .map(w => w.trim().toUpperCase())
        .filter(w => w.length >= 2 && !skipWords.includes(w.toLowerCase()) && !/^\d+$/.test(w));

      if (words.length === 0 && !trigger.recommended_ndc) {
        results.push({
          trigger_id: trigger.trigger_id,
          name: trigger.display_name,
          status: 'skipped',
          reason: 'No search terms or NDC'
        });
        continue;
      }

      // Build query
      let matchParams = [];
      let paramIndex = 1;
      const conditions = words.map(word => {
        matchParams.push(word);
        return `POSITION($${paramIndex++} IN UPPER(drug_name)) > 0`;
      });

      const keywordCondition = conditions.length > 0 ? `(${conditions.join(' AND ')})` : 'FALSE';

      // Do NOT add OR ndc condition — keyword matching only
      // The recommended_ndc can point to the wrong formulation (e.g., oral tablet vs cream)
      let ndcCondition = '';

      matchParams.push(parseInt(minClaims));
      const minClaimsIdx = paramIndex++;
      matchParams.push(parseInt(daysBack));
      const daysBackIdx = paramIndex++;
      matchParams.push(parseFloat(minMargin));
      const minMarginIdx = paramIndex++;

      const matchQuery = `
        SELECT
          insurance_bin as bin,
          insurance_group as "group",
          COUNT(*) as claim_count,
          AVG(COALESCE(
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
            )) as avg_reimbursement,
          AVG(COALESCE(quantity_dispensed, 1)) as avg_qty,
          MAX(COALESCE(dispensed_date, created_at)) as most_recent_claim
        FROM prescriptions
        WHERE (${keywordCondition}${ndcCondition})
        AND insurance_bin IS NOT NULL AND insurance_bin != ''
        AND COALESCE(dispensed_date, created_at) >= NOW() - INTERVAL '1 day' * $${daysBackIdx}
        GROUP BY insurance_bin, insurance_group
        HAVING COUNT(*) >= $${minClaimsIdx}
          AND AVG(COALESCE(
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
            )) >= $${minMarginIdx}
        ORDER BY avg_reimbursement DESC, claim_count DESC
      `;

      try {
        const matches = await db.query(matchQuery, matchParams);

        // Clear stale BIN values from previous scans (preserve manually excluded entries)
        await db.query(`
          DELETE FROM trigger_bin_values
          WHERE trigger_id = $1 AND (is_excluded = false OR is_excluded IS NULL)
        `, [trigger.trigger_id]);

        // Insert matches
        let verified = 0;
        for (const match of matches.rows) {
          await db.query(`
            INSERT INTO trigger_bin_values (
              trigger_id, insurance_bin, insurance_group, coverage_status,
              verified_at, verified_claim_count, avg_reimbursement, avg_qty, gp_value
            )
            VALUES ($1, $2, $3, 'verified', NOW(), $4, $5, $6, $5)
            ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
            DO UPDATE SET
              coverage_status = 'verified',
              verified_at = NOW(),
              verified_claim_count = $4,
              avg_reimbursement = $5,
              avg_qty = $6,
              gp_value = GREATEST(trigger_bin_values.gp_value, $5)
          `, [
            trigger.trigger_id,
            match.bin,
            match.group || null,
            parseInt(match.claim_count),
            parseFloat(match.avg_reimbursement) || 0,
            parseFloat(match.avg_qty) || 1
          ]);
          verified++;
        }

        results.push({
          trigger_id: trigger.trigger_id,
          name: trigger.display_name,
          status: 'success',
          matches_found: matches.rows.length,
          verified: verified
        });

        console.log(`  ✓ ${trigger.display_name}: ${verified} BIN/Groups verified`);
      } catch (queryError) {
        results.push({
          trigger_id: trigger.trigger_id,
          name: trigger.display_name,
          status: 'error',
          error: queryError.message
        });
        console.error(`  ✗ ${trigger.display_name}: ${queryError.message}`);
      }
    }

    const summary = {
      total_triggers: triggers.length,
      successful: results.filter(r => r.status === 'success').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      errors: results.filter(r => r.status === 'error').length,
      total_verified: results.reduce((sum, r) => sum + (r.verified || 0), 0)
    };

    console.log(`\n=== SCAN COMPLETE ===`);
    console.log(`Total: ${summary.total_triggers}, Success: ${summary.successful}, Verified: ${summary.total_verified}`);

    res.json({
      success: true,
      summary,
      results
    });
  } catch (error) {
    console.error('Error in bulk scan:', error);
    res.status(500).json({ error: 'Bulk scan failed: ' + error.message });
  }
});

// PUT /api/admin/triggers/:id/bin-values/bulk - Bulk update BIN values
router.put('/triggers/:id/bin-values/bulk', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id: triggerId } = req.params;
    const { updates } = req.body;

    if (!Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'updates must be a non-empty array' });
    }

    const results = [];
    for (const update of updates) {
      const { bin, group, gpValue, coverageStatus } = update;

      if (!bin) {
        continue; // Skip entries without BIN
      }

      const result = await db.query(`
        INSERT INTO trigger_bin_values (
          trigger_id, insurance_bin, insurance_group, gp_value, coverage_status, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
        DO UPDATE SET
          gp_value = COALESCE($4, trigger_bin_values.gp_value),
          coverage_status = COALESCE($5, trigger_bin_values.coverage_status),
          updated_at = NOW()
        RETURNING *
      `, [triggerId, bin, group || null, gpValue, coverageStatus || 'unknown']);

      results.push(result.rows[0]);
    }

    res.json({
      success: true,
      updated: results.length,
      entries: results
    });
  } catch (error) {
    console.error('Error bulk updating BIN values:', error);
    res.status(500).json({ error: 'Failed to bulk update BIN values' });
  }
});

// POST /api/admin/triggers/:id/scan - Scan all active pharmacies for a specific trigger
router.post('/triggers/:id/scan', authenticateToken, requireSuperAdmin, async (req, res) => {
  const { id: triggerId } = req.params;
  const { pharmacyId = null } = req.body; // Optional: limit to specific pharmacy

  try {
    // Verify trigger exists and is enabled
    const triggerResult = await db.query(`
      SELECT t.*,
        COALESCE(
          json_agg(
            json_build_object(
              'bin', tbv.insurance_bin,
              'insurance_bin', tbv.insurance_bin,
              'insurance_group', tbv.insurance_group,
              'gp_value', tbv.gp_value,
              'is_excluded', tbv.is_excluded,
              'coverage_status', tbv.coverage_status,
              'avg_reimbursement', tbv.avg_reimbursement,
              'best_ndc', tbv.best_ndc,
              'avg_qty', tbv.avg_qty
            )
          ) FILTER (WHERE tbv.id IS NOT NULL),
          '[]'
        ) as bin_values
      FROM triggers t
      LEFT JOIN trigger_bin_values tbv ON t.trigger_id = tbv.trigger_id
      WHERE t.trigger_id = $1
      GROUP BY t.trigger_id
    `, [triggerId]);

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }
    const trigger = triggerResult.rows[0];

    if (!trigger.is_enabled) {
      return res.status(400).json({ error: 'Trigger is disabled. Enable it first.' });
    }

    // Get pharmacies to scan (respecting pharmacy_inclusions)
    const pharmacyInclusions = trigger.pharmacy_inclusions || [];
    let pharmaciesQuery = `
      SELECT p.pharmacy_id, p.pharmacy_name
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.is_active = true AND c.status IN ('active', 'onboarding')
      AND p.pharmacy_name NOT ILIKE '%demo%' AND p.pharmacy_name NOT ILIKE '%hero%'
    `;
    const pharmaciesParams = [];
    if (pharmacyId) {
      pharmaciesQuery += ` AND p.pharmacy_id = $${pharmaciesParams.length + 1}`;
      pharmaciesParams.push(pharmacyId);
    } else if (pharmacyInclusions.length > 0) {
      pharmaciesQuery += ` AND p.pharmacy_id = ANY($${pharmaciesParams.length + 1}::uuid[])`;
      pharmaciesParams.push(pharmacyInclusions);
    }
    const pharmaciesResult = await db.query(pharmaciesQuery, pharmaciesParams);
    const pharmacies = pharmaciesResult.rows;

    console.log(`Scanning trigger "${trigger.display_name}" across ${pharmacies.length} pharmacy(ies)`);

    // Global BIN exclusions
    const EXCLUDED_BINS = ['014798'];

    let totalNewOpportunities = 0;
    let totalSkipped = 0;
    const totalPatientsMatched = new Set();
    const pharmacyResults = [];

    for (const pharmacy of pharmacies) {
      // Load prescriptions for this pharmacy
      const rxResult = await db.query(`
        SELECT
          r.prescription_id, r.patient_id, r.drug_name, r.ndc,
          r.insurance_bin as bin, r.prescriber_name,
          COALESCE(
            (r.raw_data->>'gross_profit')::numeric,
            (r.raw_data->>'net_profit')::numeric,
            (r.raw_data->>'Gross Profit')::numeric,
            (r.raw_data->>'Net Profit')::numeric,
            0
          ) as gross_profit,
          p.primary_insurance_bin
        FROM prescriptions r
        JOIN patients p ON p.patient_id = r.patient_id
        WHERE r.pharmacy_id = $1
        ORDER BY r.patient_id, r.dispensed_date DESC
      `, [pharmacy.pharmacy_id]);

      // Get existing opportunities for dedup
      const existingOppsResult = await db.query(`
        SELECT patient_id, opportunity_type, COALESCE(current_drug_name, '') as current_drug_name
        FROM opportunities WHERE pharmacy_id = $1
      `, [pharmacy.pharmacy_id]);
      const existingOpps = new Set(
        existingOppsResult.rows.map(o => `${o.patient_id}|${o.opportunity_type}|${(o.current_drug_name || '').toUpperCase()}`)
      );

      // Group by patient
      const patientRxMap = new Map();
      for (const rx of rxResult.rows) {
        if (!patientRxMap.has(rx.patient_id)) {
          patientRxMap.set(rx.patient_id, []);
        }
        patientRxMap.get(rx.patient_id).push(rx);
      }

      let pharmacyNewOpps = 0;
      let pharmacySkipped = 0;

      // Scan each patient for this trigger
      for (const [patientId, patientRxs] of patientRxMap) {
        const patientPrimaryBin = patientRxs[0]?.primary_insurance_bin;
        if (EXCLUDED_BINS.includes(patientPrimaryBin)) continue;

        const patientDrugs = patientRxs.map(rx => (rx.drug_name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' '));
        const detectKeywords = trigger.detection_keywords || [];
        const excludeKeywords = trigger.exclude_keywords || [];
        const ifHasKeywords = trigger.if_has_keywords || [];
        const ifNotHasKeywords = trigger.if_not_has_keywords || [];
        const keywordMatchMode = trigger.keyword_match_mode || 'any';

        // Find matching drug - strip special chars for matching
        let matchedDrug = null;
        let matchedRx = null;
        for (const rx of patientRxs) {
          const drugUpper = (rx.drug_name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ');
          const matchesDetect = keywordMatchMode === 'all'
            ? detectKeywords.every(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
            : detectKeywords.some(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')));
          if (!matchesDetect) continue;
          const matchesExclude = excludeKeywords.some(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')));
          if (matchesExclude) continue;
          matchedDrug = rx.drug_name;
          matchedRx = rx;
          break;
        }

        if (!matchedDrug) continue;
        totalPatientsMatched.add(patientId);

        // Check BIN inclusions/exclusions
        const binInclusions = (trigger.bin_inclusions || []).map(b => String(b).trim());
        const binExclusions = (trigger.bin_exclusions || []).map(b => String(b).trim());
        const patientBinRaw = String(matchedRx?.insurance_bin || matchedRx?.bin || patientRxs[0]?.insurance_bin || patientRxs[0]?.bin || '').trim();
        if (binInclusions.length > 0 && !binInclusions.includes(patientBinRaw)) {
          pharmacySkipped++;
          continue;
        }
        if (binExclusions.length > 0 && binExclusions.includes(patientBinRaw)) {
          pharmacySkipped++;
          continue;
        }

        // Check group inclusions/exclusions
        const groupInclusions = (trigger.group_inclusions || []).map(g => String(g).trim().toUpperCase());
        const groupExclusions = (trigger.group_exclusions || []).map(g => String(g).trim().toUpperCase());
        const patientGroupRaw = String(matchedRx?.insurance_group || matchedRx?.group_number || patientRxs[0]?.insurance_group || patientRxs[0]?.group_number || '').trim().toUpperCase();
        if (groupInclusions.length > 0 && patientGroupRaw && !groupInclusions.includes(patientGroupRaw)) {
          pharmacySkipped++;
          continue;
        }
        if (groupExclusions.length > 0 && groupExclusions.includes(patientGroupRaw)) {
          pharmacySkipped++;
          continue;
        }

        // Check IF_HAS / IF_NOT_HAS conditions
        if (ifHasKeywords.length > 0) {
          const hasRequired = ifHasKeywords.some(kw => patientDrugs.some(d => d.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' '))));
          if (!hasRequired) continue;
        }
        if (ifNotHasKeywords.length > 0) {
          const hasForbidden = ifNotHasKeywords.some(kw => patientDrugs.some(d => d.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' '))));
          if (hasForbidden) continue;
        }

        // Get GP value based on BIN pricing configuration
        const binValues = trigger.bin_values || [];
        const patientBin = matchedRx?.insurance_bin || matchedRx?.bin || patientRxs[0]?.insurance_bin || patientRxs[0]?.bin;
        const patientGroup = matchedRx?.insurance_group || matchedRx?.group_number || patientRxs[0]?.insurance_group || patientRxs[0]?.group_number;

        let gpValue;
        let binConfig = null;

        // Try to find coverage data for this patient's BIN/GROUP
        // Try exact BIN + GROUP match first
        binConfig = binValues.find(bv =>
          (bv.insurance_bin === patientBin || bv.bin === patientBin) &&
          bv.insurance_group === patientGroup
        );

        // If no exact match, try BIN-only match (group = null means "all groups")
        if (!binConfig) {
          binConfig = binValues.find(bv =>
            (bv.insurance_bin === patientBin || bv.bin === patientBin) &&
            !bv.insurance_group
          );
        }

        if (binConfig) {
          // Has explicit BIN config - check if excluded
          if (binConfig.is_excluded || binConfig.coverage_status === 'excluded') {
            pharmacySkipped++;
            continue;
          }
          gpValue = binConfig.gp_value || binConfig.avg_reimbursement || trigger.default_gp_value;
        } else {
          // BIN not in coverage data - fall through to default GP (don't skip)
          // No coverage data at all for this trigger - use default GP if set
          gpValue = trigger.default_gp_value;
        }

        // Never create opportunities with no GP value
        if (!gpValue || gpValue <= 0) {
          pharmacySkipped++;
          continue;
        }

        // Dedup check - use trigger_type for matching (matches DB constraint)
        const oppKey = `${patientId}|${trigger.trigger_type}|${(matchedDrug || '').toUpperCase()}`;
        if (existingOpps.has(oppKey)) {
          pharmacySkipped++;
          continue;
        }

        // Calculate value
        // For ADD-ON triggers (trigger name contains "ADD ON" or "ADD-ON"), GP is purely additive
        const isAddOn = (trigger.display_name || '').toUpperCase().includes('ADD ON') ||
                        (trigger.display_name || '').toUpperCase().includes('ADD-ON');
        const currentGP = matchedRx?.gross_profit || 0;
        const netGain = isAddOn ? gpValue : (gpValue - currentGP);
        if (netGain <= 0) continue;

        const annualFills = trigger.annual_fills || 12;
        const annualValue = netGain * annualFills;
        const rationale = trigger.action_instructions || trigger.clinical_rationale || `${trigger.display_name || trigger.trigger_type} opportunity`;

        // Get avg_qty from binConfig if available
        const avgDispensedQty = binConfig?.avg_qty || null;

        // Insert opportunity - use trigger_type for opportunity_type (matches DB constraint)
        await db.query(`
          INSERT INTO opportunities (
            opportunity_id, pharmacy_id, patient_id, opportunity_type,
            current_drug_name, recommended_drug_name, recommended_ndc, potential_margin_gain,
            annual_margin_gain, current_margin, prescriber_name,
            status, clinical_priority, clinical_rationale, staff_notes, avg_dispensed_qty,
            trigger_id, prescription_id
          ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `, [
          pharmacy.pharmacy_id, patientId, trigger.trigger_type,
          matchedDrug, trigger.recommended_drug, binConfig?.best_ndc || trigger.recommended_ndc || null, netGain, annualValue,
          currentGP, matchedRx?.prescriber_name || null,
          'Not Submitted', trigger.priority || 'medium', rationale,
          null,
          avgDispensedQty,
          trigger.trigger_id, matchedRx?.prescription_id || null
        ]);

        existingOpps.add(oppKey);
        pharmacyNewOpps++;
      }

      totalNewOpportunities += pharmacyNewOpps;
      totalSkipped += pharmacySkipped;
      pharmacyResults.push({
        pharmacyId: pharmacy.pharmacy_id,
        pharmacyName: pharmacy.pharmacy_name,
        newOpportunities: pharmacyNewOpps,
        skipped: pharmacySkipped
      });
    }

    res.json({
      success: true,
      trigger: { id: triggerId, name: trigger.display_name, type: trigger.trigger_type },
      pharmaciesScanned: pharmacies.length,
      opportunitiesCreated: totalNewOpportunities,
      totalNewOpportunities,
      patientsMatched: totalPatientsMatched.size,
      totalSkipped,
      results: pharmacyResults
    });
  } catch (error) {
    console.error('Error scanning trigger:', error);
    res.status(500).json({ error: 'Failed to scan trigger: ' + error.message });
  }
});


// ===========================================
// AUDIT RULES ENDPOINTS
// ===========================================

// GET /api/admin/audit-rules - List all audit rules
router.get('/audit-rules', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ rules: [], message: 'Audit rules temporarily disabled' });
  try {
    const result = await db.query(`
      SELECT * FROM audit_rules ORDER BY rule_type, rule_name
    `);

    // Get per-pharmacy audit risk stats for all rules
    const pharmacyStatsResult = await db.query(`
      SELECT
        ar.rule_id,
        af.pharmacy_id,
        ph.pharmacy_name,
        COUNT(*) as risk_count,
        COUNT(DISTINCT af.patient_id) as patient_count,
        COALESCE(SUM(af.gross_profit), 0) as total_exposure
      FROM audit_rules ar
      LEFT JOIN audit_flags af ON af.rule_id = ar.rule_id AND af.status = 'open'
      LEFT JOIN pharmacies ph ON ph.pharmacy_id = af.pharmacy_id
      WHERE af.flag_id IS NOT NULL
      GROUP BY ar.rule_id, af.pharmacy_id, ph.pharmacy_name
      ORDER BY ar.rule_id, total_exposure DESC
    `);

    // Build a map of rule_id -> pharmacy stats
    const pharmacyStatsByRule = {};
    pharmacyStatsResult.rows.forEach(row => {
      if (!pharmacyStatsByRule[row.rule_id]) {
        pharmacyStatsByRule[row.rule_id] = [];
      }
      pharmacyStatsByRule[row.rule_id].push({
        pharmacy_id: row.pharmacy_id,
        pharmacy_name: row.pharmacy_name,
        risk_count: parseInt(row.risk_count),
        patient_count: parseInt(row.patient_count),
        total_exposure: parseFloat(row.total_exposure) || 0
      });
    });

    // Add pharmacy stats to each rule
    const rulesWithStats = result.rows.map(rule => ({
      ...rule,
      pharmacy_stats: pharmacyStatsByRule[rule.rule_id] || [],
      total_risks: (pharmacyStatsByRule[rule.rule_id] || []).reduce((sum, p) => sum + p.risk_count, 0),
      total_patients: (pharmacyStatsByRule[rule.rule_id] || []).reduce((sum, p) => sum + p.patient_count, 0),
      total_exposure: (pharmacyStatsByRule[rule.rule_id] || []).reduce((sum, p) => sum + p.total_exposure, 0)
    }));

    res.json({ rules: rulesWithStats });
  } catch (error) {
    console.error('Error fetching audit rules:', error);
    res.status(500).json({ error: 'Failed to fetch audit rules' });
  }
});

// GET /api/admin/audit-rules/:id - Get single audit rule
router.get('/audit-rules/:id', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ rule: null, message: 'Audit rules temporarily disabled' });
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
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
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
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
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
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
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
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ flags: [], total: 0, message: 'Audit rules temporarily disabled' });
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
  const { scanType = 'all', triggerId = null } = req.body; // scanType: 'all', 'opportunities', 'audit'; triggerId: scan only this trigger

  try {
    console.log(`Starting rescan for pharmacy ${pharmacyId}, type: ${scanType}${triggerId ? `, trigger: ${triggerId}` : ''}`);

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
    // Use Gross Profit from raw_data if available, otherwise calculate from components
    const rxResult = await db.query(`
      SELECT
        r.prescription_id, r.patient_id, r.drug_name, r.ndc,
        r.quantity_dispensed as quantity, r.days_supply,
        r.dispensed_date, r.insurance_bin as bin, r.insurance_pcn as pcn,
        r.insurance_group as group_number,
        COALESCE(
          (r.raw_data->>'gross_profit')::numeric,
          (r.raw_data->>'net_profit')::numeric,
          (r.raw_data->>'Gross Profit')::numeric,
          (r.raw_data->>'Net Profit')::numeric,
          0
        ) as gross_profit,
        r.daw_code, r.sig, r.prescriber_name,
        p.first_name as patient_first_name, p.last_name as patient_last_name,
        p.primary_insurance_bin
      FROM prescriptions r
      JOIN patients p ON p.patient_id = r.patient_id
      WHERE r.pharmacy_id = $1
      ORDER BY r.patient_id, r.dispensed_date DESC
    `, [pharmacyId]);

    const prescriptions = rxResult.rows;
    console.log(`Loaded ${prescriptions.length} prescriptions`);

    // Load enabled triggers (or just one if triggerId specified)
    const triggersQuery = `
      SELECT t.*,
        COALESCE(
          json_agg(
            json_build_object('bin', tbv.insurance_bin, 'insurance_bin', tbv.insurance_bin, 'insurance_group', tbv.insurance_group, 'gp_value', tbv.gp_value, 'is_excluded', tbv.is_excluded, 'coverage_status', tbv.coverage_status, 'avg_reimbursement', tbv.avg_reimbursement, 'best_ndc', tbv.best_ndc, 'avg_qty', tbv.avg_qty)
          ) FILTER (WHERE tbv.id IS NOT NULL),
          '[]'
        ) as bin_values
      FROM triggers t
      LEFT JOIN trigger_bin_values tbv ON t.trigger_id = tbv.trigger_id
      WHERE t.is_enabled = true
      ${triggerId ? 'AND t.trigger_id = $1' : ''}
      GROUP BY t.trigger_id
    `;
    const triggersResult = triggerId
      ? await db.query(triggersQuery, [triggerId])
      : await db.query(triggersQuery);
    const triggers = triggersResult.rows;
    console.log(`Loaded ${triggers.length} trigger(s)${triggerId ? ` (filtered to ${triggerId})` : ''}`);

    // Load enabled audit rules
    const auditResult = await db.query('SELECT * FROM audit_rules WHERE is_enabled = true');
    const auditRules = auditResult.rows;
    console.log(`Loaded ${auditRules.length} enabled audit rules`);

    // Get existing opportunities to avoid duplicates
    // Use opportunity_type + current_drug_name as the dedup key (handle NULL drug names)
    const existingOppsResult = await db.query(`
      SELECT patient_id, opportunity_type, COALESCE(current_drug_name, '') as current_drug_name
      FROM opportunities
      WHERE pharmacy_id = $1
    `, [pharmacyId]);
    const existingOpps = new Set(
      existingOppsResult.rows.map(o => `${o.patient_id}|${o.opportunity_type}|${(o.current_drug_name || '').toUpperCase()}`)
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

    // Global BIN exclusions (cash BINs that shouldn't trigger opportunities)
    const EXCLUDED_BINS = ['014798'];

    // Scan for opportunities
    if (scanType === 'all' || scanType === 'opportunities') {
      for (const [patientId, patientRxs] of patientRxMap) {
        const patientDrugs = patientRxs.map(rx => (rx.drug_name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' '));
        const patientBin = patientRxs[0]?.bin;
        const patientGroup = patientRxs[0]?.group_number;
        const patientPrimaryBin = patientRxs[0]?.primary_insurance_bin;

        // Skip entire patient if their primary BIN is excluded (e.g., cash BIN 014798)
        if (EXCLUDED_BINS.includes(patientPrimaryBin)) {
          console.log(`Skipping patient ${patientId} - primary_insurance_bin ${patientPrimaryBin} is excluded`);
          continue;
        }

        for (const trigger of triggers) {
          // Check detection keywords
          const detectKeywords = trigger.detection_keywords || [];
          const excludeKeywords = trigger.exclude_keywords || [];
          const ifHasKeywords = trigger.if_has_keywords || [];
          const ifNotHasKeywords = trigger.if_not_has_keywords || [];
          const keywordMatchMode = trigger.keyword_match_mode || 'any';

          // Find matching drug - strip special chars for matching
          let matchedDrug = null;
          let matchedRx = null;
          for (const rx of patientRxs) {
            const drugUpper = (rx.drug_name || '').toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ');

            // Check if drug matches detection keywords (any vs all mode)
            const matchesDetect = keywordMatchMode === 'all'
              ? detectKeywords.every(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
              : detectKeywords.some(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')));
            if (!matchesDetect) continue;

            // Check if drug is excluded
            const matchesExclude = excludeKeywords.some(kw => drugUpper.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')));
            if (matchesExclude) continue;

            matchedDrug = rx.drug_name;
            matchedRx = rx;
            break;
          }

          if (!matchedDrug) continue;

          // Check BIN inclusions/exclusions
          const binInclusions = (trigger.bin_inclusions || []).map(b => String(b).trim());
          const binExclusions = (trigger.bin_exclusions || []).map(b => String(b).trim());
          const patientBinRaw = String(matchedRx?.bin || patientRxs[0]?.bin || '').trim();
          if (binInclusions.length > 0 && !binInclusions.includes(patientBinRaw)) continue;
          if (binExclusions.length > 0 && binExclusions.includes(patientBinRaw)) continue;

          // Check group inclusions/exclusions
          const groupInclusions = (trigger.group_inclusions || []).map(g => String(g).trim().toUpperCase());
          const groupExclusions = (trigger.group_exclusions || []).map(g => String(g).trim().toUpperCase());
          const patientGroupRaw = String(matchedRx?.group_number || patientRxs[0]?.group_number || '').trim().toUpperCase();
          if (groupInclusions.length > 0 && patientGroupRaw && !groupInclusions.includes(patientGroupRaw)) continue;
          if (groupExclusions.length > 0 && groupExclusions.includes(patientGroupRaw)) continue;

          // Check IF_HAS condition (patient must have these drugs)
          if (ifHasKeywords.length > 0) {
            const hasRequired = ifHasKeywords.some(kw =>
              patientDrugs.some(d => d.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
            );
            if (!hasRequired) continue;
          }

          // Check IF_NOT_HAS condition (for missing therapy triggers)
          if (ifNotHasKeywords.length > 0) {
            const hasForbidden = ifNotHasKeywords.some(kw =>
              patientDrugs.some(d => d.includes(kw.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ').replace(/\s+/g, ' ')))
            );
            if (hasForbidden) continue; // Patient already has this therapy
          }

          // Get GP value for this BIN - only create opportunities where we have coverage data
          const binValues = trigger.bin_values || [];
          let gpValue;
          let binConfig = null;

          // Try to find BIN-specific coverage
          binConfig = binValues.find(bv =>
            (bv.insurance_bin === patientBin || bv.bin === patientBin) &&
            bv.insurance_group === patientGroup
          );
          if (!binConfig) {
            binConfig = binValues.find(bv =>
              (bv.insurance_bin === patientBin || bv.bin === patientBin) &&
              !bv.insurance_group
            );
          }

          if (binConfig) {
            if (binConfig.is_excluded || binConfig.coverage_status === 'excluded') continue;
            gpValue = binConfig.gp_value || binConfig.avg_reimbursement || trigger.default_gp_value;
          } else {
            // BIN not in coverage data - fall through to default GP (don't skip)
            gpValue = trigger.default_gp_value;
          }

          // Never create opportunities with no GP value
          if (!gpValue || gpValue <= 0) {
            skippedOpportunities++;
            continue;
          }

          // Check if opportunity already exists (using opportunity_type + drug as key)
          const oppKey = `${patientId}|${trigger.trigger_type}|${(matchedDrug || '').toUpperCase()}`;
          if (existingOpps.has(oppKey)) {
            skippedOpportunities++;
            continue;
          }

          // Create new opportunity
          const annualFills = trigger.annual_fills || 12;
          // Calculate net gain: expected GP - current GP from prescription
          const currentGP = matchedRx?.gross_profit || 0;
          const netGain = gpValue - currentGP;
          const annualValue = netGain * annualFills;

          // Skip if no positive net gain (not worthwhile to switch)
          if (netGain <= 0) {
            console.log(`Skipping ${matchedDrug}: netGain=${netGain} (expected ${gpValue} - current ${currentGP})`);
            continue;
          }

          // Use action_instructions for clinical rationale (what staff should do)
          const rationale = trigger.action_instructions || trigger.clinical_rationale || `${trigger.display_name || trigger.trigger_type} opportunity`;

          // Get avg_qty from binConfig if available
          const avgDispensedQty = binConfig?.avg_qty || null;

          await db.query(`
            INSERT INTO opportunities (
              opportunity_id, pharmacy_id, patient_id, opportunity_type,
              current_drug_name, recommended_drug_name, recommended_ndc, potential_margin_gain,
              annual_margin_gain, current_margin, prescriber_name,
              status, clinical_priority, clinical_rationale, staff_notes, avg_dispensed_qty,
              trigger_id, prescription_id
            ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
          `, [
            pharmacyId,
            patientId,
            trigger.trigger_type,
            matchedDrug,
            trigger.recommended_drug,
            binConfig?.best_ndc || trigger.recommended_ndc || null,
            netGain,
            annualValue,
            currentGP,
            matchedRx?.prescriber_name || null,
            'Not Submitted',
            trigger.priority || 'medium',
            rationale,
            null,
            avgDispensedQty,
            trigger.trigger_id, matchedRx?.prescription_id || null
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

      // Scan for CVS Aberrant Products
      // Flag prescriptions with CVS BINs and NDCs on the aberrant product list
      console.log('Scanning for CVS aberrant products...');

      // Load CVS managed BINs
      const cvsBinsResult = await db.query('SELECT bin FROM cvs_managed_bins');
      const cvsBins = new Set(cvsBinsResult.rows.map(r => r.bin));
      console.log(`Loaded ${cvsBins.size} CVS managed BINs`);

      // Load aberrant NDCs
      const aberrantResult = await db.query('SELECT ndc, product_name FROM cvs_aberrant_products');
      const aberrantNdcs = new Map();
      for (const row of aberrantResult.rows) {
        // Store with and without leading zeros (NDC format variations)
        aberrantNdcs.set(row.ndc, row.product_name);
        aberrantNdcs.set(row.ndc.replace(/^0+/, ''), row.product_name); // Remove leading zeros
      }
      console.log(`Loaded ${aberrantResult.rows.length} aberrant products`);

      let cvsAberrantFlags = 0;

      for (const rx of prescriptions) {
        // Check if prescription has a CVS managed BIN
        const rxBin = rx.insurance_bin || rx.bin || '';
        if (!cvsBins.has(rxBin)) continue;

        // Check if NDC is on aberrant list
        const rxNdc = (rx.ndc || '').replace(/-/g, ''); // Remove dashes
        const aberrantProduct = aberrantNdcs.get(rxNdc) || aberrantNdcs.get(rxNdc.replace(/^0+/, ''));
        if (!aberrantProduct) continue;

        // This is a CVS aberrant product - create audit flag
        const drugUpper = rx.drug_name?.toUpperCase() || '';
        const flagKey = `${rx.patient_id}|CVS_ABERRANT|${drugUpper}|${rx.dispensed_date}`;
        if (existingFlags.has(flagKey)) {
          skippedAuditFlags++;
          continue;
        }

        const violation = `CVS ABERRANT PRODUCT: ${rx.drug_name} (NDC: ${rxNdc}) is on CVS Caremark's Aberrant Product List. Dispensing >25% of claims from this list can result in network termination.`;

        await db.query(`
          INSERT INTO audit_flags (
            pharmacy_id, patient_id, prescription_id, rule_id,
            rule_type, severity, drug_name, ndc, dispensed_quantity,
            days_supply, daw_code, sig, gross_profit,
            violation_message, expected_value, actual_value,
            status, dispensed_date
          ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `, [
          pharmacyId,
          rx.patient_id,
          rx.prescription_id,
          'cvs_aberrant',
          'high',
          rx.drug_name,
          rx.ndc,
          rx.quantity,
          rx.days_supply,
          rx.daw_code,
          rx.sig,
          rx.gross_profit,
          violation,
          'Avoid aberrant products',
          `BIN: ${rxBin}, NDC on aberrant list`,
          'open',
          rx.dispensed_date
        ]);

        cvsAberrantFlags++;
        existingFlags.add(flagKey);
      }

      newAuditFlags += cvsAberrantFlags;
      console.log(`Found ${cvsAberrantFlags} CVS aberrant product flags`);
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

// GET /api/admin/pharmacies/:id/cvs-aberrant-metrics - Get CVS aberrant percentage metrics
router.get('/pharmacies/:id/cvs-aberrant-metrics', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const pharmacyId = req.params.id;

    // Verify pharmacy exists
    const pharmacyResult = await db.query(
      'SELECT pharmacy_name FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );
    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }
    const pharmacyName = pharmacyResult.rows[0].pharmacy_name;

    // Load CVS managed BINs
    const cvsBinsResult = await db.query('SELECT bin FROM cvs_managed_bins');
    const cvsBins = cvsBinsResult.rows.map(r => r.bin);

    if (cvsBins.length === 0) {
      return res.json({
        pharmacy: pharmacyName,
        error: 'No CVS BINs configured. Run load-cvs-aberrant.js first.',
        status: 'unknown'
      });
    }

    // Load aberrant NDCs
    const aberrantResult = await db.query('SELECT ndc FROM cvs_aberrant_products');
    const aberrantNdcs = new Set();
    for (const row of aberrantResult.rows) {
      aberrantNdcs.add(row.ndc);
      aberrantNdcs.add(row.ndc.replace(/^0+/, '')); // Without leading zeros
    }

    // Get all CVS BIN prescriptions
    const cvsRxResult = await db.query(`
      SELECT
        ndc,
        COALESCE(insurance_pay, 0) as insurance_pay,
        COALESCE(patient_pay, 0) as patient_pay,
        drug_name
      FROM prescriptions
      WHERE pharmacy_id = $1
        AND insurance_bin = ANY($2)
    `, [pharmacyId, cvsBins]);

    let totalCvsRxCount = 0;
    let totalCvsInsurancePaid = 0;
    let aberrantRxCount = 0;
    let aberrantInsurancePaid = 0;
    const aberrantDrugs = {};

    for (const rx of cvsRxResult.rows) {
      totalCvsRxCount++;
      totalCvsInsurancePaid += parseFloat(rx.insurance_pay) || 0;

      const rxNdc = (rx.ndc || '').replace(/-/g, '');
      const isAberrant = aberrantNdcs.has(rxNdc) || aberrantNdcs.has(rxNdc.replace(/^0+/, ''));

      if (isAberrant) {
        aberrantRxCount++;
        aberrantInsurancePaid += parseFloat(rx.insurance_pay) || 0;

        // Track by drug name
        const drugName = rx.drug_name || 'Unknown';
        if (!aberrantDrugs[drugName]) {
          aberrantDrugs[drugName] = { count: 0, insurancePaid: 0 };
        }
        aberrantDrugs[drugName].count++;
        aberrantDrugs[drugName].insurancePaid += parseFloat(rx.insurance_pay) || 0;
      }
    }

    // Calculate percentages
    const percentByCount = totalCvsRxCount > 0 ? (aberrantRxCount / totalCvsRxCount) * 100 : 0;
    const percentByDollars = totalCvsInsurancePaid > 0 ? (aberrantInsurancePaid / totalCvsInsurancePaid) * 100 : 0;

    // Determine status (use higher of the two percentages)
    const maxPercent = Math.max(percentByCount, percentByDollars);
    let status = 'safe';
    let statusMessage = 'Below 20% threshold';
    if (maxPercent >= 25) {
      status = 'critical';
      statusMessage = 'CRITICAL: Exceeds 25% threshold - risk of network termination';
    } else if (maxPercent >= 20) {
      status = 'warning';
      statusMessage = 'WARNING: Approaching 25% threshold';
    }

    // Sort aberrant drugs by count
    const topAberrantDrugs = Object.entries(aberrantDrugs)
      .map(([drug, data]) => ({ drug, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    res.json({
      pharmacy: pharmacyName,
      status,
      statusMessage,
      metrics: {
        totalCvsRxCount,
        totalCvsInsurancePaid: Math.round(totalCvsInsurancePaid * 100) / 100,
        aberrantRxCount,
        aberrantInsurancePaid: Math.round(aberrantInsurancePaid * 100) / 100,
        percentByCount: Math.round(percentByCount * 100) / 100,
        percentByDollars: Math.round(percentByDollars * 100) / 100
      },
      thresholds: {
        warning: 20,
        critical: 25
      },
      topAberrantDrugs
    });

  } catch (error) {
    console.error('Error getting CVS aberrant metrics:', error);
    res.status(500).json({ error: 'Failed to get CVS aberrant metrics: ' + error.message });
  }
});

// GET /api/admin/reimbursement-monitor - Monitor recommended drug reimbursements by BIN
router.get('/reimbursement-monitor', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { bin, pharmacyId } = req.query;

    // Get all triggers with recommended drugs
    const triggers = await db.query(`
      SELECT trigger_id, display_name, recommended_drug, recommended_ndc, default_gp_value
      FROM triggers
      WHERE is_enabled = true AND recommended_drug IS NOT NULL
    `);

    const results = [];

    for (const trigger of triggers.rows) {
      const recDrug = (trigger.recommended_drug || '').toUpperCase();
      const keywords = recDrug.split(/[\s,()-]+/).filter(w => w.length > 3);

      if (keywords.length === 0) continue;

      // Build dynamic query to find matching drugs
      let query = `
        SELECT
          insurance_bin,
          insurance_group,
          COUNT(*) as rx_count,
          AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0)) as avg_gp,
          AVG(COALESCE(insurance_pay, 0)) as avg_ins_pay,
          MAX(dispensed_date) as last_fill_date
        FROM prescriptions
        WHERE 1=1
      `;
      const params = [];
      let paramIndex = 1;

      if (pharmacyId) {
        query += ` AND pharmacy_id = $${paramIndex++}`;
        params.push(pharmacyId);
      }

      if (bin) {
        query += ` AND insurance_bin = $${paramIndex++}`;
        params.push(bin);
      }

      // Match by keywords
      const keywordConditions = keywords.map(kw => {
        params.push(kw);
        return `POSITION($${paramIndex++} IN UPPER(drug_name)) > 0`;
      }).join(' OR ');
      query += ` AND (${keywordConditions})`;

      query += `
        GROUP BY insurance_bin, insurance_group
        HAVING COUNT(*) >= 3
        ORDER BY AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0)) DESC
        LIMIT 20
      `;

      const claimData = await db.query(query, params);

      if (claimData.rows.length > 0) {
        results.push({
          triggerId: trigger.trigger_id,
          triggerName: trigger.display_name,
          recommendedDrug: trigger.recommended_drug,
          defaultGp: trigger.default_gp_value,
          reimbursementByBin: claimData.rows.map(r => ({
            bin: r.insurance_bin,
            group: r.insurance_group,
            rxCount: parseInt(r.rx_count),
            avgGp: Math.round(parseFloat(r.avg_gp || 0) * 100) / 100,
            avgInsPay: Math.round(parseFloat(r.avg_ins_pay || 0) * 100) / 100,
            lastFillDate: r.last_fill_date
          }))
        });
      }
    }

    res.json({
      triggerCount: results.length,
      filters: { bin, pharmacyId },
      triggers: results
    });

  } catch (error) {
    console.error('Error in reimbursement monitor:', error);
    res.status(500).json({ error: 'Failed to get reimbursement data: ' + error.message });
  }
});

// POST /api/admin/pharmacies/:id/scan-reimbursement-changes - Scan for reimbursement changes between refills
router.post('/pharmacies/:id/scan-reimbursement-changes', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const pharmacyId = req.params.id;
    const { thresholdPercent = 25, thresholdDollars = 20 } = req.body;

    // Verify pharmacy exists
    const pharmacyResult = await db.query(
      'SELECT pharmacy_name FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );
    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }
    const pharmacyName = pharmacyResult.rows[0].pharmacy_name;

    console.log(`Scanning reimbursement changes for ${pharmacyName}...`);

    // Find prescriptions with multiple fills (refills) and compare reimbursements
    // Group by rx_number base (without refill suffix) and patient
    const rxChanges = await db.query(`
      WITH rx_history AS (
        SELECT
          prescription_id,
          patient_id,
          rx_number,
          drug_name,
          ndc,
          insurance_bin,
          insurance_group,
          COALESCE(insurance_pay, 0) as insurance_pay,
          COALESCE(acquisition_cost, 0) as acquisition_cost,
          COALESCE(
            (raw_data->>'gross_profit')::numeric,
            (raw_data->>'net_profit')::numeric,
            (raw_data->>'Gross Profit')::numeric,
            (raw_data->>'Net Profit')::numeric,
            0
          ) as gross_profit,
          dispensed_date,
          LAG(COALESCE(insurance_pay, 0)) OVER (
            PARTITION BY patient_id, UPPER(TRIM(drug_name))
            ORDER BY dispensed_date
          ) as prev_ins_pay,
          LAG(COALESCE(
            (raw_data->>'gross_profit')::numeric,
            (raw_data->>'net_profit')::numeric,
            (raw_data->>'Gross Profit')::numeric,
            (raw_data->>'Net Profit')::numeric,
            0
          )) OVER (
            PARTITION BY patient_id, UPPER(TRIM(drug_name))
            ORDER BY dispensed_date
          ) as prev_gp,
          LAG(dispensed_date) OVER (
            PARTITION BY patient_id, UPPER(TRIM(drug_name))
            ORDER BY dispensed_date
          ) as prev_fill_date
        FROM prescriptions
        WHERE pharmacy_id = $1
          AND insurance_pay IS NOT NULL
          AND insurance_pay > 0
      )
      SELECT *,
        insurance_pay - prev_ins_pay as pay_change,
        gross_profit - prev_gp as gp_change,
        CASE
          WHEN prev_ins_pay > 0 THEN ((insurance_pay - prev_ins_pay) / prev_ins_pay * 100)
          ELSE 0
        END as pay_change_pct
      FROM rx_history
      WHERE prev_ins_pay IS NOT NULL
        AND (
          ABS(insurance_pay - prev_ins_pay) >= $2
          OR (prev_ins_pay > 0 AND ABS((insurance_pay - prev_ins_pay) / prev_ins_pay * 100) >= $3)
        )
      ORDER BY ABS(insurance_pay - prev_ins_pay) DESC
      LIMIT 500
    `, [pharmacyId, thresholdDollars, thresholdPercent]);

    console.log(`Found ${rxChanges.rows.length} significant reimbursement changes`);

    // Get existing flags to avoid duplicates
    const existingFlagsResult = await db.query(
      `SELECT patient_id, rule_type, drug_name, dispensed_date
       FROM audit_flags
       WHERE pharmacy_id = $1 AND rule_type IN ('reimbursement_increase', 'reimbursement_decrease')`,
      [pharmacyId]
    );
    const existingFlags = new Set(
      existingFlagsResult.rows.map(f => `${f.patient_id}|${f.rule_type}|${(f.drug_name || '').toUpperCase()}|${f.dispensed_date}`)
    );

    let increasesCreated = 0;
    let decreasesCreated = 0;
    let skipped = 0;

    for (const rx of rxChanges.rows) {
      const isIncrease = rx.pay_change > 0;
      const ruleType = isIncrease ? 'reimbursement_increase' : 'reimbursement_decrease';
      const severity = Math.abs(rx.pay_change) >= 50 ? 'high' : 'medium';

      const flagKey = `${rx.patient_id}|${ruleType}|${(rx.drug_name || '').toUpperCase()}|${rx.dispensed_date}`;
      if (existingFlags.has(flagKey)) {
        skipped++;
        continue;
      }

      const changeDir = isIncrease ? 'INCREASED' : 'DECREASED';
      const violation = `REIMBURSEMENT ${changeDir}: ${rx.drug_name} payment ${changeDir.toLowerCase()} from $${rx.prev_ins_pay?.toFixed(2)} to $${rx.insurance_pay?.toFixed(2)} (${rx.pay_change >= 0 ? '+' : ''}$${rx.pay_change?.toFixed(2)}, ${rx.pay_change_pct?.toFixed(1)}%). Previous fill: ${rx.prev_fill_date?.toISOString().split('T')[0]}`;

      await db.query(`
        INSERT INTO audit_flags (
          pharmacy_id, patient_id, prescription_id,
          rule_type, severity, drug_name, ndc,
          gross_profit, violation_message,
          expected_value, actual_value,
          status, dispensed_date
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        pharmacyId,
        rx.patient_id,
        rx.prescription_id,
        ruleType,
        severity,
        rx.drug_name,
        rx.ndc,
        rx.gross_profit,
        violation,
        `Previous: $${rx.prev_ins_pay?.toFixed(2)}`,
        `Current: $${rx.insurance_pay?.toFixed(2)} (${rx.pay_change >= 0 ? '+' : ''}${rx.pay_change_pct?.toFixed(1)}%)`,
        'open',
        rx.dispensed_date
      ]);

      if (isIncrease) {
        increasesCreated++;
      } else {
        decreasesCreated++;
      }
      existingFlags.add(flagKey);
    }

    // Summary statistics
    const increases = rxChanges.rows.filter(r => r.pay_change > 0);
    const decreases = rxChanges.rows.filter(r => r.pay_change < 0);

    res.json({
      success: true,
      pharmacy: pharmacyName,
      thresholds: { thresholdPercent, thresholdDollars },
      results: {
        totalChangesFound: rxChanges.rows.length,
        flagsCreated: increasesCreated + decreasesCreated,
        increasesCreated,
        decreasesCreated,
        skipped
      },
      summary: {
        increases: {
          count: increases.length,
          avgChange: increases.length > 0 ? Math.round(increases.reduce((s, r) => s + r.pay_change, 0) / increases.length * 100) / 100 : 0,
          maxChange: increases.length > 0 ? Math.max(...increases.map(r => r.pay_change)) : 0
        },
        decreases: {
          count: decreases.length,
          avgChange: decreases.length > 0 ? Math.round(decreases.reduce((s, r) => s + r.pay_change, 0) / decreases.length * 100) / 100 : 0,
          maxChange: decreases.length > 0 ? Math.min(...decreases.map(r => r.pay_change)) : 0
        }
      }
    });

  } catch (error) {
    console.error('Error scanning reimbursement changes:', error);
    res.status(500).json({ error: 'Failed to scan reimbursement changes: ' + error.message });
  }
});

// GET /api/admin/recommended-drug-gp/:bin - Get actual GP for recommended drugs on a specific BIN
router.get('/recommended-drug-gp/:bin', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { bin } = req.params;
    const { pharmacyId } = req.query;

    // Get all triggers with recommended drugs
    const triggers = await db.query(`
      SELECT t.trigger_id, t.display_name, t.recommended_drug, t.recommended_ndc,
             tbv.gp_value as configured_gp, t.default_gp_value
      FROM triggers t
      LEFT JOIN trigger_bin_values tbv ON t.trigger_id = tbv.trigger_id AND tbv.insurance_bin = $1
      WHERE t.is_enabled = true AND t.recommended_drug IS NOT NULL
      ORDER BY t.display_name
    `, [bin]);

    const results = [];

    for (const trigger of triggers.rows) {
      const recDrug = (trigger.recommended_drug || '').toUpperCase();
      const keywords = recDrug.split(/[\s,()-]+/).filter(w => w.length > 3);

      if (keywords.length === 0) continue;

      // Build query for this BIN
      let query = `
        SELECT
          drug_name,
          COUNT(*) as rx_count,
          AVG(COALESCE((raw_data->>'gross_profit')::numeric, (raw_data->>'net_profit')::numeric, (raw_data->>'Gross Profit')::numeric, (raw_data->>'Net Profit')::numeric, 0)) as avg_gp,
          AVG(COALESCE(insurance_pay, 0)) as avg_ins_pay,
          MIN(dispensed_date) as first_fill,
          MAX(dispensed_date) as last_fill
        FROM prescriptions
        WHERE insurance_bin = $1
      `;
      const params = [bin];
      let paramIndex = 2;

      if (pharmacyId) {
        query += ` AND pharmacy_id = $${paramIndex++}`;
        params.push(pharmacyId);
      }

      const keywordConditions = keywords.map(kw => {
        params.push(kw);
        return `POSITION($${paramIndex++} IN UPPER(drug_name)) > 0`;
      }).join(' OR ');
      query += ` AND (${keywordConditions})`;
      query += ` GROUP BY drug_name ORDER BY COUNT(*) DESC LIMIT 5`;

      const claimData = await db.query(query, params);

      const totalRx = claimData.rows.reduce((s, r) => s + parseInt(r.rx_count), 0);
      const weightedGp = totalRx > 0
        ? claimData.rows.reduce((s, r) => s + (parseFloat(r.avg_gp || 0) * parseInt(r.rx_count)), 0) / totalRx
        : null;

      results.push({
        triggerId: trigger.trigger_id,
        triggerName: trigger.display_name,
        recommendedDrug: trigger.recommended_drug,
        configuredGp: trigger.configured_gp,
        defaultGp: trigger.default_gp_value,
        actualGp: weightedGp ? Math.round(weightedGp * 100) / 100 : null,
        rxCount: totalRx,
        difference: weightedGp && trigger.configured_gp
          ? Math.round((weightedGp - trigger.configured_gp) * 100) / 100
          : null,
        matchingDrugs: claimData.rows.map(r => ({
          drugName: r.drug_name,
          rxCount: parseInt(r.rx_count),
          avgGp: Math.round(parseFloat(r.avg_gp || 0) * 100) / 100,
          lastFill: r.last_fill
        }))
      });
    }

    // Sort by difference (biggest discrepancies first)
    results.sort((a, b) => Math.abs(b.difference || 0) - Math.abs(a.difference || 0));

    res.json({
      bin,
      pharmacyId: pharmacyId || 'all',
      triggerCount: results.length,
      verified: results.filter(r => r.actualGp !== null).length,
      triggers: results
    });

  } catch (error) {
    console.error('Error getting recommended drug GP:', error);
    res.status(500).json({ error: 'Failed to get recommended drug GP: ' + error.message });
  }
});

// POST /api/admin/clients - Create a new client (super admin only)
router.post('/clients', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const {
      clientName,
      pharmacyName,
      pharmacyNpi,
      pharmacyNcpdp,
      pharmacyState,
      pharmacyAddress,
      pharmacyCity,
      pharmacyZip,
      pharmacyPhone,
      pharmacyFax,
      adminEmail,
      adminFirstName,
      adminLastName,
      pmsSystem,
      status
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
      `, [clientId, clientName, finalSubdomain, adminEmail.toLowerCase(), status || 'active']);

      // Create pharmacy (trim state to 2 chars, NPI to 10)
      await txClient.query(`
        INSERT INTO pharmacies (pharmacy_id, client_id, pharmacy_name, pharmacy_npi, ncpdp, state, address, city, zip, phone, fax, pms_system, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      `, [
        pharmacyId,
        clientId,
        pharmacyName || clientName,
        pharmacyNpi ? pharmacyNpi.slice(0, 10) : null,
        pharmacyNcpdp ? pharmacyNcpdp.slice(0, 7) : null,
        pharmacyState ? pharmacyState.slice(0, 2).toUpperCase() : null,
        pharmacyAddress || null,
        pharmacyCity || null,
        pharmacyZip || null,
        pharmacyPhone || null,
        pharmacyFax || null,
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


// POST /api/admin/clients/:clientId/pharmacies - Add a new pharmacy/store to an existing client
router.post('/clients/:clientId/pharmacies', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const {
      pharmacyName,
      pharmacyNpi,
      pharmacyNcpdp,
      pharmacyState,
      pharmacyAddress,
      pharmacyCity,
      pharmacyZip,
      pharmacyPhone,
      pharmacyFax,
      pmsSystem,
      adminEmail,
      adminFirstName,
      adminLastName
    } = req.body;

    // Verify client exists
    const clientResult = await db.query(
      'SELECT client_id, client_name FROM clients WHERE client_id = $1',
      [clientId]
    );
    if (clientResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    const client = clientResult.rows[0];

    // Validate required fields
    if (!pharmacyName) {
      return res.status(400).json({ error: 'Pharmacy name is required' });
    }

    // Generate IDs
    const pharmacyId = uuidv4();

    // Create pharmacy
    await db.query(`
      INSERT INTO pharmacies (pharmacy_id, client_id, pharmacy_name, pharmacy_npi, ncpdp, state, address, city, zip, phone, fax, pms_system, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
    `, [
      pharmacyId,
      clientId,
      pharmacyName,
      pharmacyNpi ? pharmacyNpi.slice(0, 10) : null,
      pharmacyNcpdp ? pharmacyNcpdp.slice(0, 7) : null,
      pharmacyState ? pharmacyState.slice(0, 2).toUpperCase() : null,
      pharmacyAddress || null,
      pharmacyCity || null,
      pharmacyZip || null,
      pharmacyPhone || null,
      pharmacyFax || null,
      pmsSystem || null
    ]);

    // Optionally create admin user for this pharmacy if email provided
    let credentials = null;
    if (adminEmail) {
      // Check if email already exists
      const existingUser = await db.query(
        'SELECT user_id FROM users WHERE email = $1',
        [adminEmail.toLowerCase()]
      );
      if (existingUser.rows.length > 0) {
        return res.status(400).json({ error: 'A user with this email already exists' });
      }

      const userId = uuidv4();
      const tempPassword = uuidv4().slice(0, 12);
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      await db.query(`
        INSERT INTO users (user_id, client_id, pharmacy_id, email, password_hash, first_name, last_name, role, is_active, must_change_password, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin', true, true, NOW())
      `, [userId, clientId, pharmacyId, adminEmail.toLowerCase(), passwordHash, adminFirstName || 'Admin', adminLastName || '']);

      credentials = {
        email: adminEmail.toLowerCase(),
        temporaryPassword: tempPassword
      };
    }

    console.log('New pharmacy added to client:', { clientId, clientName: client.client_name, pharmacyId, pharmacyName });

    res.status(201).json({
      success: true,
      pharmacy: {
        pharmacyId,
        pharmacyName,
        clientId,
        clientName: client.client_name
      },
      credentials
    });
  } catch (error) {
    console.error('Error adding pharmacy to client:', error);
    res.status(500).json({ error: 'Failed to add pharmacy: ' + error.message });
  }
});


// POST /api/admin/triggers/generate-all-justifications - Generate clinical justifications for all triggers
router.post('/triggers/generate-all-justifications', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { overwrite = false, triggerType = 'therapeutic_interchange' } = req.body;

    // Get triggers that need justifications
    let query = `
      SELECT trigger_id, display_name, trigger_type, category, detection_keywords, recommended_drug, clinical_rationale
      FROM triggers
      WHERE trigger_type = $1
    `;
    const params = [triggerType];

    if (!overwrite) {
      query += ` AND (clinical_rationale IS NULL OR clinical_rationale = '')`;
    }

    query += ` ORDER BY display_name`;

    const triggersResult = await db.query(query, params);
    const triggers = triggersResult.rows;

    if (triggers.length === 0) {
      return res.json({
        success: true,
        message: overwrite
          ? 'No triggers found of the specified type'
          : 'All triggers already have clinical justifications',
        processed: 0,
        succeeded: 0,
        failed: 0
      });
    }

    console.log(`Generating clinical justifications for ${triggers.length} triggers...`);

    // Generate justifications
    const results = await generateJustificationsForTriggers(triggers, (current, total, trigger) => {
      console.log(`[${current}/${total}] Processing: ${trigger.display_name}`);
    });

    // Update successful ones in database
    let succeeded = 0;
    let failed = 0;

    for (const result of results) {
      if (result.success) {
        await db.query(
          `UPDATE triggers SET clinical_rationale = $1, updated_at = NOW() WHERE trigger_id = $2`,
          [result.justification, result.trigger_id]
        );
        succeeded++;
        console.log(`  Updated: ${result.display_name}`);
      } else {
        failed++;
        console.error(`  Failed: ${result.display_name} - ${result.error}`);
      }
    }

    console.log(`Completed: ${succeeded} succeeded, ${failed} failed`);

    res.json({
      success: true,
      processed: triggers.length,
      succeeded,
      failed,
      results: results.map(r => ({
        trigger_id: r.trigger_id,
        display_name: r.display_name,
        success: r.success,
        error: r.error
      }))
    });
  } catch (error) {
    console.error('Generate all justifications error:', error);
    res.status(500).json({ error: 'Failed to generate justifications: ' + error.message });
  }
});


// POST /api/admin/triggers/:triggerId/generate-justification - Generate clinical justification for a single trigger
router.post('/triggers/:triggerId/generate-justification', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { triggerId } = req.params;

    // Get trigger
    const triggerResult = await db.query(
      `SELECT trigger_id, display_name, trigger_type, category, detection_keywords, recommended_drug
       FROM triggers WHERE trigger_id = $1`,
      [triggerId]
    );

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    const trigger = triggerResult.rows[0];

    console.log(`Generating clinical justification for: ${trigger.display_name}`);

    // Generate justification
    const justification = await generateClinicalJustification(trigger);

    // Update in database
    await db.query(
      `UPDATE triggers SET clinical_rationale = $1, updated_at = NOW() WHERE trigger_id = $2`,
      [justification, triggerId]
    );

    console.log(`Updated clinical rationale for: ${trigger.display_name}`);

    res.json({
      success: true,
      trigger_id: triggerId,
      display_name: trigger.display_name,
      clinical_rationale: justification
    });
  } catch (error) {
    console.error('Generate justification error:', error);
    res.status(500).json({ error: 'Failed to generate justification: ' + error.message });
  }
});


// POST /api/admin/triggers/:triggerId/scan-coverage - Scan coverage for a SPECIFIC trigger
router.post('/triggers/:triggerId/scan-coverage', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { triggerId } = req.params;
    const { minMargin = 10, daysBack = 365 } = req.body;

    // Get the trigger
    const triggerResult = await db.query(
      `SELECT * FROM triggers WHERE trigger_id = $1`,
      [triggerId]
    );

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    const trigger = triggerResult.rows[0];
    const recommendedDrug = trigger.recommended_drug || '';
    const recommendedNdc = trigger.recommended_ndc || null;
    const excludeKeywords = trigger.exclude_keywords || [];
    console.log(`Scanning coverage for trigger: ${trigger.display_name}, recommended_drug: "${recommendedDrug}", recommended_ndc: ${recommendedNdc || 'none'}`);

    // Build search from RECOMMENDED DRUG (not detection_keywords)
    // We want to find claims for the drug we're recommending, not the drug patients are currently on
    const skipWords = ['mg', 'ml', 'mcg', 'er', 'sr', 'xr', 'dr', 'hcl', 'sodium', 'potassium', 'try', 'alternates', 'if', 'fails', 'before', 'saying', 'doesnt', 'work', 'the', 'and', 'for', 'with'];
    const words = recommendedDrug
      .split(/[\s,.\-\(\)\[\]]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length >= 2 && !skipWords.includes(w.toLowerCase()) && !/^\d+$/.test(w));

    if (words.length === 0 && !recommendedNdc) {
      return res.status(400).json({ error: 'Trigger has no recommended drug or NDC set' });
    }

    // Build keyword search: each word from recommended_drug must appear (AND)
    const allParams = [];
    let paramIndex = 1;
    const wordConditions = words.map(word => {
      allParams.push(word);
      return `POSITION($${paramIndex++} IN UPPER(p.drug_name)) > 0`;
    });
    let keywordCondition = wordConditions.length > 0 ? `(${wordConditions.join(' AND ')})` : 'FALSE';

    // Do NOT add OR NDC match - it pulls wrong drug formulations
    // e.g. recommended_ndc for Diclofenac 2% pump could match oral tablet claims
    // Keyword matching alone is sufficient and more accurate

    // NOTE: exclude_keywords are NOT applied to coverage scans.
    // They are for the opportunity scanner (e.g., exclude patients already on ODT).
    // The coverage scan searches for the RECOMMENDED drug, so exclude_keywords would
    // incorrectly filter out the exact drug we're looking for.
    const excludeCondition = '';

    // minMargin param
    allParams.push(minMargin);
    const minMarginIdx = paramIndex++;

    // Build normalization SQL based on trigger's expected_qty/expected_days_supply
    const DAYS_EST = `COALESCE(p.days_supply, CASE WHEN COALESCE(p.quantity_dispensed,0) > 60 THEN 90 WHEN COALESCE(p.quantity_dispensed,0) > 34 THEN 60 ELSE 30 END)`;
    const GP_RAW = `COALESCE(
            (p.raw_data->>'gross_profit')::numeric,
            (p.raw_data->>'net_profit')::numeric,
            (p.raw_data->>'Gross Profit')::numeric,
            (p.raw_data->>'Net Profit')::numeric,
            0
          )`;

    let gpNorm2, qtyNorm2, daysFilter2;
    if (trigger.expected_qty) {
      const expectedQty = parseFloat(trigger.expected_qty);
      gpNorm2 = `${GP_RAW} * (${expectedQty} / GREATEST(COALESCE(p.quantity_dispensed, ${expectedQty})::numeric, 1))`;
      qtyNorm2 = `${expectedQty}`;
      const minDays2 = trigger.expected_days_supply ? Math.floor(trigger.expected_days_supply * 0.8) : 20;
      daysFilter2 = `${DAYS_EST} >= ${minDays2}`;
    } else if (trigger.expected_days_supply) {
      gpNorm2 = `${GP_RAW} * (30.0 / GREATEST(${DAYS_EST}::numeric, 1))`;
      qtyNorm2 = `COALESCE(p.quantity_dispensed, 1) * (30.0 / GREATEST(${DAYS_EST}::numeric, 1))`;
      const minDays2 = Math.floor(trigger.expected_days_supply * 0.8);
      daysFilter2 = `${DAYS_EST} >= ${minDays2}`;
    } else {
      gpNorm2 = `${GP_RAW} / GREATEST(CEIL(${DAYS_EST}::numeric / 30.0), 1)`;
      qtyNorm2 = `COALESCE(p.quantity_dispensed, 1) / GREATEST(CEIL(${DAYS_EST}::numeric / 30.0), 1)`;
      daysFilter2 = `${DAYS_EST} >= 28`;
    }

    // Find BEST reimbursing product per BIN/Group (with drug name + NDC)
    // GP normalized per expected fill unit when expected_qty is set, otherwise per 30 days
    const prescriptionsResult = await db.query(`
      WITH claim_gp AS (
        SELECT
          p.insurance_bin as bin,
          p.insurance_group as group_number,
          p.drug_name,
          p.ndc,
          ${gpNorm2} as gp,
          ${qtyNorm2} as qty,
          p.days_supply
        FROM prescriptions p
        WHERE p.dispensed_date >= NOW() - INTERVAL '${daysBack} days'
          AND (${keywordCondition})
          ${excludeCondition}
          AND p.insurance_bin IS NOT NULL
          AND ${daysFilter2}
      ),
      ranked_products AS (
        SELECT
          bin, group_number, drug_name, ndc,
          COUNT(*) as claim_count,
          AVG(gp) as avg_gp,
          AVG(qty) as avg_qty,
          ROW_NUMBER() OVER (
            PARTITION BY bin, group_number
            ORDER BY AVG(gp) DESC
          ) as rank
        FROM claim_gp
        GROUP BY bin, group_number, drug_name, ndc
        HAVING AVG(gp) >= $${minMarginIdx}
      )
      SELECT bin, group_number, drug_name, ndc, claim_count,
        ROUND(avg_gp::numeric, 2) as avg_gp, ROUND(avg_qty::numeric, 1) as avg_qty
      FROM ranked_products
      WHERE rank = 1
      ORDER BY avg_gp DESC
    `, allParams);

    const binValues = prescriptionsResult.rows.map(row => ({
      bin: row.bin,
      group: row.group_number,
      gpValue: parseFloat(row.avg_gp) || 0,
      avgQty: parseFloat(row.avg_qty) || 0,
      claimCount: parseInt(row.claim_count),
      bestDrugName: row.drug_name || null,
      bestNdc: row.ndc || null,
      coverageStatus: 'verified',
      verifiedAt: new Date().toISOString()
    }));

    // Auto-update trigger: default_gp from median GP (not max) for reasonable estimates
    const gpValues = binValues
      .map(bv => bv.gpValue)
      .filter(gp => gp > 0)
      .sort((a, b) => a - b);
    const medianGP = gpValues.length > 0
      ? gpValues.length % 2 === 0
        ? (gpValues[gpValues.length / 2 - 1] + gpValues[gpValues.length / 2]) / 2
        : gpValues[Math.floor(gpValues.length / 2)]
      : null;
    await db.query(`
      UPDATE triggers
      SET synced_at = NOW(),
          updated_at = NOW(),
          default_gp_value = COALESCE($2, default_gp_value)
      WHERE trigger_id = $1
    `, [triggerId, medianGP]);

    // Clear stale BIN values from previous scans (preserve manually excluded entries)
    await db.query(`
      DELETE FROM trigger_bin_values
      WHERE trigger_id = $1 AND (is_excluded = false OR is_excluded IS NULL)
    `, [triggerId]);

    // Store bin values in trigger_bin_values table (with best drug name + NDC)
    for (const bv of binValues) {
      await db.query(`
        INSERT INTO trigger_bin_values (trigger_id, insurance_bin, insurance_group, gp_value, avg_qty, verified_claim_count, coverage_status, verified_at, best_drug_name, best_ndc)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9)
        ON CONFLICT (trigger_id, insurance_bin, COALESCE(insurance_group, ''))
        DO UPDATE SET gp_value = $4, avg_qty = $5, verified_claim_count = $6, coverage_status = $7, verified_at = NOW(), best_drug_name = $8, best_ndc = $9
      `, [triggerId, bv.bin, bv.group, bv.gpValue, bv.avgQty, bv.claimCount, bv.coverageStatus, bv.bestDrugName, bv.bestNdc]);
    }

    // Backfill "Not Submitted" opportunities with updated GP, qty, and NDC per BIN/GROUP
    if (binValues.length > 0) {
      const backfillResult = await db.query(`
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
      `, [triggerId, medianGP || 0]);
      console.log(`Backfilled ${backfillResult.rowCount} opportunities with updated GP values`);
    }

    console.log(`Found ${binValues.length} BIN/Groups for trigger: ${trigger.display_name}`);

    // If no coverage found, just log it — don't auto-disable
    if (binValues.length === 0) {
      console.log(`No coverage results for trigger "${trigger.display_name}" — trigger remains enabled`);
    }

    // Find all drug name variations matching the search terms
    let drugVariations = [];
    try {
      const varParams = [];
      let varParamIdx = 1;
      const varConditions = words.map(word => {
        varParams.push(word);
        return `POSITION($${varParamIdx++} IN UPPER(p.drug_name)) > 0`;
      });
      const varCondition = varConditions.length > 0 ? `(${varConditions.join(' AND ')})` : 'FALSE';
      const varResult = await db.query(`
        SELECT UPPER(p.drug_name) as drug_name, COUNT(*) as claim_count, COUNT(DISTINCT p.ndc) as ndc_count,
               array_agg(DISTINCT p.ndc) as ndcs
        FROM prescriptions p
        WHERE ${varCondition}
          AND p.dispensed_date >= NOW() - INTERVAL '${daysBack} days'
          AND p.insurance_bin IS NOT NULL
        GROUP BY UPPER(p.drug_name)
        ORDER BY claim_count DESC
      `, varParams);
      drugVariations = varResult.rows.map(r => ({
        drugName: r.drug_name,
        claimCount: parseInt(r.claim_count),
        ndcCount: parseInt(r.ndc_count),
        ndcs: (r.ndcs || []).filter(Boolean).slice(0, 5)
      }));
    } catch (varError) {
      console.error('Error fetching drug variations:', varError.message);
    }

    res.json({
      success: true,
      triggerId,
      triggerName: trigger.display_name,
      binCount: binValues.length,
      prescriptionCount: binValues.reduce((sum, b) => sum + b.claimCount, 0),
      binValues: binValues.slice(0, 20),
      drugVariations
    });
    invalidateCache('trigger-coverage:');
  } catch (error) {
    console.error('Scan trigger coverage error:', error);
    res.status(500).json({ error: 'Failed to scan coverage: ' + error.message });
  }
});

// POST /api/admin/triggers/:triggerId/scan-pharmacy/:pharmacyId - Scan a pharmacy for opportunities from a specific trigger
router.post('/triggers/:triggerId/scan-pharmacy/:pharmacyId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { triggerId, pharmacyId } = req.params;
    const { daysBack = 90 } = req.body;

    // Get the trigger with exclusions
    const triggerResult = await db.query(
      `SELECT * FROM triggers WHERE trigger_id = $1`,
      [triggerId]
    );

    if (triggerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trigger not found' });
    }

    const trigger = triggerResult.rows[0];
    console.log(`Scanning pharmacy ${pharmacyId} for trigger: ${trigger.display_name}`);

    // Build search patterns from detection keywords
    const keywords = trigger.detection_keywords || [];
    if (keywords.length === 0) {
      return res.status(400).json({ error: 'Trigger has no detection keywords' });
    }

    // Parse exclusions
    const binInclusions = (trigger.bin_inclusions || []).map(b => String(b).trim());
    const binExclusions = (trigger.bin_exclusions || []).map(b => String(b).trim());
    const groupInclusions = (trigger.group_inclusions || []).map(g => String(g).trim());
    const groupExclusions = trigger.group_exclusions || [];
    const contractPrefixExclusions = trigger.contract_prefix_exclusions || [];

    // Find matching patients in this pharmacy (with exclusion filters)
    const keywordPatterns = keywords.map(k => `%${k.toLowerCase()}%`);

    // Build inclusion/exclusion conditions
    let exclusionConditions = '';
    const exclusionParams = [];
    let paramOffset = keywordPatterns.length + 2; // +2 for pharmacyId and daysBack placeholder

    // BIN inclusions - only allow these BINs
    if (binInclusions.length > 0) {
      exclusionConditions += ` AND pr.insurance_bin IN (${binInclusions.map((_, i) => `$${paramOffset + i}`).join(', ')})`;
      exclusionParams.push(...binInclusions);
      paramOffset += binInclusions.length;
    }

    // BIN exclusions - exclude these BINs
    if (binExclusions.length > 0) {
      exclusionConditions += ` AND pr.insurance_bin NOT IN (${binExclusions.map((_, i) => `$${paramOffset + i}`).join(', ')})`;
      exclusionParams.push(...binExclusions);
      paramOffset += binExclusions.length;
    }

    // Group inclusions - only allow these groups
    if (groupInclusions.length > 0) {
      exclusionConditions += ` AND (pr.insurance_group IS NOT NULL AND pr.insurance_group IN (${groupInclusions.map((_, i) => `$${paramOffset + i}`).join(', ')}))`;
      exclusionParams.push(...groupInclusions);
      paramOffset += groupInclusions.length;
    }

    if (groupExclusions.length > 0) {
      exclusionConditions += ` AND (pr.insurance_group IS NULL OR pr.insurance_group NOT IN (${groupExclusions.map((_, i) => `$${paramOffset + i}`).join(', ')}))`;
      exclusionParams.push(...groupExclusions);
      paramOffset += groupExclusions.length;
    }

    if (contractPrefixExclusions.length > 0) {
      const prefixConditions = contractPrefixExclusions.map((_, i) => `pr.insurance_group NOT LIKE $${paramOffset + i} || '%'`).join(' AND ');
      exclusionConditions += ` AND (pr.insurance_group IS NULL OR (${prefixConditions}))`;
      exclusionParams.push(...contractPrefixExclusions);
    }

    const patientsResult = await db.query(`
      SELECT DISTINCT ON (p.patient_id)
        p.patient_id,
        p.first_name,
        p.last_name,
        pr.prescription_id,
        pr.drug_name as current_drug,
        pr.ndc as current_ndc,
        pr.prescriber_name,
        COALESCE(
          (pr.raw_data->>'gross_profit')::numeric,
          (pr.raw_data->>'net_profit')::numeric,
          (pr.raw_data->>'Gross Profit')::numeric,
          (pr.raw_data->>'Net Profit')::numeric,
          0
        ) as gross_profit,
        pr.quantity_dispensed,
        pr.insurance_bin as bin,
        pr.insurance_group as group_number
      FROM patients p
      JOIN prescriptions pr ON pr.patient_id = p.patient_id
      WHERE p.pharmacy_id = $1
        AND pr.dispensed_date >= NOW() - INTERVAL '${daysBack} days'
        AND (${keywordPatterns.map((_, i) => `LOWER(pr.drug_name) LIKE $${i + 2}`).join(' OR ')})
        ${exclusionConditions}
      ORDER BY p.patient_id, pr.dispensed_date DESC
    `, [pharmacyId, ...keywordPatterns, ...exclusionParams]);

    console.log(`Found ${patientsResult.rows.length} matching patients (after exclusions: ${groupExclusions.length} groups, ${contractPrefixExclusions.length} prefixes)`);

    // Create opportunities for each patient (if not already exists)
    // Also check for therapeutic duplicates (same drug class)
    let opportunitiesCreated = 0;
    let skippedDuplicates = 0;
    const patientsMatched = new Set();

    for (const patient of patientsResult.rows) {
      patientsMatched.add(patient.patient_id);

      // Check if opportunity already exists for this exact recommendation
      const existing = await db.query(`
        SELECT 1 FROM opportunities
        WHERE patient_id = $1
          AND recommended_drug_name = $2
          AND status = 'Not Submitted'
      `, [patient.patient_id, trigger.recommended_drug]);

      if (existing.rows.length > 0) {
        continue;
      }

      // Check for therapeutic duplicates - same trigger_group (e.g., multiple statin options)
      // Only create if this would be the highest-value option for this therapeutic area
      if (trigger.trigger_group) {
        const betterExists = await db.query(`
          SELECT o.opportunity_id, o.recommended_drug_name, o.annual_margin_gain
          FROM opportunities o
          JOIN triggers t ON t.recommended_drug = o.recommended_drug_name
          WHERE o.patient_id = $1
            AND o.status = 'Not Submitted'
            AND t.trigger_group = $2
            AND o.annual_margin_gain >= $3
          LIMIT 1
        `, [patient.patient_id, trigger.trigger_group, (trigger.default_gp_value || 0) * (trigger.annual_fills || 12)]);

        if (betterExists.rows.length > 0) {
          skippedDuplicates++;
          continue;
        }
      }

      // Create new opportunity
      await db.query(`
        INSERT INTO opportunities (
          opportunity_id, pharmacy_id, patient_id, opportunity_type, trigger_group,
          current_drug_name, current_ndc, recommended_drug_name, recommended_ndc,
          prescriber_name, annual_margin_gain, clinical_rationale, status, created_at,
          trigger_id, prescription_id
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'Not Submitted', NOW(), $12, $13
        )
      `, [
        pharmacyId,
        patient.patient_id,
        trigger.trigger_type || 'therapeutic_interchange',
        trigger.trigger_group || null,
        patient.current_drug,
        patient.current_ndc,
        trigger.recommended_drug,
        trigger.recommended_ndc,
        patient.prescriber_name,
        (trigger.default_gp_value || 0) * (trigger.annual_fills || 12),
        trigger.clinical_rationale,
        trigger.trigger_id, patient.prescription_id || null
      ]);
      opportunitiesCreated++;
    }

    console.log(`Created ${opportunitiesCreated} opportunities for pharmacy ${pharmacyId} (skipped ${skippedDuplicates} duplicates)`);

    res.json({
      success: true,
      triggerId,
      pharmacyId,
      triggerName: trigger.display_name,
      patientsMatched: patientsMatched.size,
      opportunitiesCreated,
      skippedDuplicates,
      exclusionsApplied: {
        groupExclusions: groupExclusions.length,
        contractPrefixExclusions: contractPrefixExclusions.length
      }
    });
  } catch (error) {
    console.error('Scan pharmacy for trigger error:', error);
    res.status(500).json({ error: 'Failed to scan pharmacy: ' + error.message });
  }
});


// POST /api/admin/triggers/verify-all-coverage - Scan coverage for ALL triggers at once
// For NDC optimization triggers: finds BEST reimbursing product per BIN/Group
// For other triggers: verifies recommended drug exists with good margin
router.post('/triggers/verify-all-coverage', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { minClaims = 1, daysBack = 365, minMargin = 10, dmeMinMargin = 3 } = req.body;

    const { scanAllTriggerCoverage } = await import('../services/coverage-scanner.js');
    const result = await scanAllTriggerCoverage({ minClaims, daysBack, minMargin, dmeMinMargin });

    // Invalidate trigger coverage cache
    invalidateCache('trigger-coverage:');

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error in bulk coverage verification:', error);
    res.status(500).json({ error: 'Failed to verify coverage: ' + error.message });
  }
});

// ===========================================

// ===========================================
// AUDIT SCANNING ENDPOINTS
// ===========================================

// POST /api/admin/audit-rules/:ruleId/scan-pharmacy/:pharmacyId - Scan specific rule for specific pharmacy
router.post('/audit-rules/:ruleId/scan-pharmacy/:pharmacyId', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
  try {
    const { ruleId, pharmacyId } = req.params;
    const { lookbackDays = 90 } = req.body;

    // Verify rule exists
    const ruleResult = await db.query('SELECT * FROM audit_rules WHERE rule_id = $1', [ruleId]);
    if (ruleResult.rows.length === 0) {
      return res.status(404).json({ error: 'Audit rule not found' });
    }
    const rule = ruleResult.rows[0];

    // Verify pharmacy exists
    const pharmacyResult = await db.query('SELECT pharmacy_name FROM pharmacies WHERE pharmacy_id = $1', [pharmacyId]);
    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    // Run the scan using the audit scanner for this specific rule
    const results = await auditScanner.runRuleScan(pharmacyId, ruleId, {
      lookbackDays: parseInt(lookbackDays)
    });

    res.json({
      success: true,
      pharmacyName: pharmacyResult.rows[0].pharmacy_name,
      ruleName: rule.rule_name,
      ...results
    });
  } catch (error) {
    console.error('Audit rule scan error:', error);
    res.status(500).json({ error: 'Audit scan failed: ' + error.message });
  }
});

// POST /api/admin/audit/scan - Run audit scan for a pharmacy or all pharmacies
router.post('/audit/scan', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
  try {
    const { pharmacyId, lookbackDays = 90, clearExisting = true } = req.body;

    let results;

    if (pharmacyId) {
      // Scan single pharmacy
      results = await auditScanner.runFullAuditScan(pharmacyId, {
        lookbackDays: parseInt(lookbackDays),
        clearExisting
      });
    } else {
      // Scan all pharmacies
      results = await auditScanner.runAuditScanAll({
        lookbackDays: parseInt(lookbackDays),
        clearExisting
      });
    }

    res.json({
      success: true,
      results
    });
  } catch (error) {
    console.error('Audit scan error:', error);
    res.status(500).json({ error: 'Audit scan failed: ' + error.message });
  }
});

// GET /api/admin/audit/summary - Get audit summary across all pharmacies
router.get('/audit/summary', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ summary: {}, message: 'Audit rules temporarily disabled' });
  try {
    const [bySeverity, byPharmacy, byType, recentCritical] = await Promise.all([
      // Total by severity
      db.query(`
        SELECT severity, COUNT(*) as count
        FROM audit_flags
        WHERE status = 'open'
        GROUP BY severity
        ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END
      `),

      // By pharmacy
      db.query(`
        SELECT
          p.pharmacy_name,
          p.pharmacy_id,
          COUNT(*) as total_flags,
          COUNT(*) FILTER (WHERE af.severity = 'critical') as critical_count,
          COUNT(*) FILTER (WHERE af.severity = 'warning') as warning_count
        FROM audit_flags af
        JOIN pharmacies p ON p.pharmacy_id = af.pharmacy_id
        WHERE af.status = 'open'
        GROUP BY p.pharmacy_id, p.pharmacy_name
        ORDER BY critical_count DESC, total_flags DESC
      `),

      // By rule type
      db.query(`
        SELECT rule_type, COUNT(*) as count
        FROM audit_flags
        WHERE status = 'open'
        GROUP BY rule_type
        ORDER BY count DESC
      `),

      // Recent critical flags
      db.query(`
        SELECT
          af.flag_id,
          af.drug_name,
          af.violation_message,
          af.dispensed_date,
          af.flagged_at,
          p.pharmacy_name
        FROM audit_flags af
        JOIN pharmacies p ON p.pharmacy_id = af.pharmacy_id
        WHERE af.status = 'open' AND af.severity = 'critical'
        ORDER BY af.flagged_at DESC
        LIMIT 20
      `)
    ]);

    res.json({
      bySeverity: bySeverity.rows,
      byPharmacy: byPharmacy.rows,
      byType: byType.rows,
      recentCritical: recentCritical.rows,
      totalOpen: bySeverity.rows.reduce((sum, r) => sum + parseInt(r.count), 0)
    });
  } catch (error) {
    console.error('Audit summary error:', error);
    res.status(500).json({ error: 'Failed to get audit summary: ' + error.message });
  }
});

// GET /api/admin/audit/pharmacy/:pharmacyId - Get audit details for specific pharmacy
router.get('/audit/pharmacy/:pharmacyId', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ summary: {}, message: 'Audit rules temporarily disabled' });
  try {
    const { pharmacyId } = req.params;

    const summary = await auditScanner.getAuditSummary(pharmacyId);

    // Get pharmacy info
    const pharmacyResult = await db.query(`
      SELECT p.pharmacy_name, c.client_name
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [pharmacyId]);

    res.json({
      pharmacy: pharmacyResult.rows[0],
      ...summary
    });
  } catch (error) {
    console.error('Pharmacy audit error:', error);
    res.status(500).json({ error: 'Failed to get pharmacy audit: ' + error.message });
  }
});

// PUT /api/admin/audit/flags/:flagId - Update audit flag status (bulk or single)
router.put('/audit/flags/:flagId', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
  try {
    const { flagId } = req.params;
    const { status, resolution_notes } = req.body;

    const result = await db.query(`
      UPDATE audit_flags
      SET status = $1,
          resolution_notes = $2,
          reviewed_by = $3,
          reviewed_at = NOW()
      WHERE flag_id = $4
      RETURNING *
    `, [status, resolution_notes, req.user.userId, flagId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Audit flag not found' });
    }

    res.json({ flag: result.rows[0] });
  } catch (error) {
    console.error('Update audit flag error:', error);
    res.status(500).json({ error: 'Failed to update audit flag: ' + error.message });
  }
});

// POST /api/admin/audit/flags/bulk-update - Bulk update audit flags
router.post('/audit/flags/bulk-update', authenticateToken, requireSuperAdmin, async (req, res) => {
  // TEMPORARILY DISABLED - audit rules not yet fully developed (see TODO.md)
  return res.json({ success: true, message: 'Audit rules temporarily disabled' });
  try {
    const { flagIds, status, resolution_notes } = req.body;

    if (!Array.isArray(flagIds) || flagIds.length === 0) {
      return res.status(400).json({ error: 'flagIds array required' });
    }

    const result = await db.query(`
      UPDATE audit_flags
      SET status = $1,
          resolution_notes = $2,
          reviewed_by = $3,
          reviewed_at = NOW()
      WHERE flag_id = ANY($4)
      RETURNING flag_id
    `, [status, resolution_notes, req.user.userId, flagIds]);

    res.json({
      success: true,
      updatedCount: result.rows.length
    });
  } catch (error) {
    console.error('Bulk update audit flags error:', error);
    res.status(500).json({ error: 'Failed to bulk update audit flags: ' + error.message });
  }
});

// PATCH /api/admin/clients/:clientId - Update client and pharmacy details
router.patch('/clients/:clientId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { pharmacyName, clientName, email, state, address, city, zip, phone, npi, status } = req.body;

    // Get pharmacy_id for this client
    const pharmacyResult = await db.query(
      'SELECT pharmacy_id FROM pharmacies WHERE client_id = $1',
      [clientId]
    );

    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const pharmacyId = pharmacyResult.rows[0].pharmacy_id;

    // Update client
    if (clientName || email || status) {
      const clientUpdates = [];
      const clientValues = [];
      let idx = 1;

      if (clientName) {
        clientUpdates.push(`client_name = $${idx++}`);
        clientValues.push(clientName);
      }
      if (email) {
        clientUpdates.push(`submitter_email = $${idx++}`);
        clientValues.push(email);
      }
      if (status) {
        clientUpdates.push(`status = $${idx++}`);
        clientValues.push(status);
      }

      if (clientUpdates.length > 0) {
        clientValues.push(clientId);
        await db.query(
          `UPDATE clients SET ${clientUpdates.join(', ')} WHERE client_id = $${idx}`,
          clientValues
        );
      }
    }

    // Update pharmacy
    const pharmUpdates = [];
    const pharmValues = [];
    let pIdx = 1;

    if (pharmacyName) { pharmUpdates.push(`pharmacy_name = $${pIdx++}`); pharmValues.push(pharmacyName); }
    if (state) { pharmUpdates.push(`state = $${pIdx++}`); pharmValues.push(state); }
    if (address) { pharmUpdates.push(`address = $${pIdx++}`); pharmValues.push(address); }
    if (city) { pharmUpdates.push(`city = $${pIdx++}`); pharmValues.push(city); }
    if (zip) { pharmUpdates.push(`zip = $${pIdx++}`); pharmValues.push(zip); }
    if (phone) { pharmUpdates.push(`phone = $${pIdx++}`); pharmValues.push(phone); }
    if (npi) { pharmUpdates.push(`pharmacy_npi = $${pIdx++}`); pharmValues.push(npi); }

    if (pharmUpdates.length > 0) {
      pharmValues.push(pharmacyId);
      await db.query(
        `UPDATE pharmacies SET ${pharmUpdates.join(', ')} WHERE pharmacy_id = $${pIdx}`,
        pharmValues
      );
    }

    // Update user email if provided
    if (email) {
      await db.query(
        `UPDATE users SET email = $1 WHERE user_id = (
          SELECT user_id FROM users WHERE pharmacy_id = $2 AND role = 'admin' LIMIT 1
        )`,
        [email, pharmacyId]
      );
    }

    // Fetch updated data
    const updated = await db.query(`
      SELECT p.pharmacy_name, p.state, p.address, p.city, p.zip, p.phone, p.pharmacy_npi,
             c.client_name, c.submitter_email, c.status
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE c.client_id = $1
    `, [clientId]);

    console.log(`Updated client ${clientId}:`, updated.rows[0]);
    res.json({ success: true, data: updated.rows[0] });
  } catch (error) {
    console.error('Update client error:', error);
    res.status(500).json({ error: 'Failed to update client: ' + error.message });
  }
});

// POST /api/admin/clients/:clientId/email-documents - Email BAA and Agreement to client
router.post('/clients/:clientId/email-documents', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;

    // Get client info
    const result = await db.query(`
      SELECT c.client_name, c.submitter_email, p.pharmacy_name, p.state, p.address, p.city, p.zip
      FROM clients c
      LEFT JOIN pharmacies p ON p.client_id = c.client_id
      WHERE c.client_id = $1
    `, [clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = result.rows[0];
    const pharmacyName = client.pharmacy_name || client.client_name;
    const email = client.submitter_email;

    if (!email) {
      return res.status(400).json({ error: 'No email address found for this client' });
    }

    // Generate documents
    const documents = await generateOnboardingDocuments({
      pharmacyName,
      companyName: client.client_name,
      email,
      state: client.state,
      address: client.address,
      city: client.city,
      zip: client.zip,
    });

    // Send email with just documents (no credentials)
    const { sendWelcomeEmail } = await import('../services/emailService.js');

    // Use a modified version - send docs only
    const nodemailer = await import('nodemailer');
    const transport = await getEmailTransport();

    if (!transport) {
      return res.json({
        success: false,
        error: 'Email not configured',
        documents: {
          baa: { filename: documents.baaFilename, base64: documents.baa.toString('base64') },
          serviceAgreement: { filename: documents.serviceAgreementFilename, base64: documents.serviceAgreement.toString('base64') },
        }
      });
    }

    const mailResult = await transport.sendMail({
      from: '"TheRxOS" <stan@therxos.com>',
      to: email,
      subject: `TheRxOS Documents - ${pharmacyName}`,
      text: `Hello,\n\nPlease find attached your Business Associate Agreement (BAA) and Service Agreement for TheRxOS.\n\nPlease review, sign, and return these documents to stan@therxos.com.\n\nIf you have any questions, please reply to this email.\n\nBest regards,\nStan\nTheRxOS`,
      html: `
        <p>Hello,</p>
        <p>Please find attached your <strong>Business Associate Agreement (BAA)</strong> and <strong>Service Agreement</strong> for TheRxOS.</p>
        <p>Please review, sign, and return these documents to <a href="mailto:stan@therxos.com">stan@therxos.com</a>.</p>
        <p>If you have any questions, please reply to this email.</p>
        <p>Best regards,<br><strong>Stan</strong><br>TheRxOS</p>
      `,
      attachments: [
        { filename: documents.baaFilename, content: documents.baa },
        { filename: documents.serviceAgreementFilename, content: documents.serviceAgreement },
      ],
    });

    console.log(`Documents emailed to ${email} for ${pharmacyName}`);
    res.json({ success: true, messageId: mailResult.messageId });
  } catch (error) {
    console.error('Email documents error:', error);
    res.status(500).json({ error: 'Failed to email documents: ' + error.message });
  }
});

// Helper to get email transport
async function getEmailTransport() {
  const nodemailer = (await import('nodemailer')).default;

  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }

  // Try Gmail OAuth
  if (process.env.GMAIL_CLIENT_ID) {
    try {
      const { google } = await import('googleapis');
      const tokenResult = await db.query(
        "SELECT token_data FROM system_settings WHERE setting_key = 'gmail_oauth_tokens'"
      );

      if (tokenResult.rows.length > 0) {
        const oauth2Client = new google.auth.OAuth2(
          process.env.GMAIL_CLIENT_ID,
          process.env.GMAIL_CLIENT_SECRET,
          process.env.GMAIL_REDIRECT_URI
        );

        const tokens = typeof tokenResult.rows[0].token_data === 'string'
          ? JSON.parse(tokenResult.rows[0].token_data)
          : tokenResult.rows[0].token_data;
        oauth2Client.setCredentials(tokens);

        const accessToken = await oauth2Client.getAccessToken();

        return nodemailer.createTransport({
          service: 'gmail',
          auth: {
            type: 'OAuth2',
            user: process.env.GMAIL_USER || 'stan@therxos.com',
            clientId: process.env.GMAIL_CLIENT_ID,
            clientSecret: process.env.GMAIL_CLIENT_SECRET,
            refreshToken: tokens.refresh_token,
            accessToken: accessToken.token,
          },
        });
      }
    } catch (err) {
      console.error('Gmail OAuth setup failed:', err.message);
    }
  }

  return null;
}

// PATCH /api/admin/clients/:clientId/status - Update client status (onboarding -> active)
router.patch('/clients/:clientId/status', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { status } = req.body;

    if (!['onboarding', 'active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: onboarding, active, or suspended' });
    }

    const result = await db.query(`
      UPDATE clients
      SET status = $1
      WHERE client_id = $2
      RETURNING client_id, client_name, status
    `, [status, clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    console.log(`Client ${result.rows[0].client_name} status updated to ${status}`);
    res.json({ success: true, client: result.rows[0] });
  } catch (error) {
    console.error('Update client status error:', error);
    res.status(500).json({ error: 'Failed to update client status' });
  }
});

// POST /api/admin/clients/:clientId/generate-documents - Generate BAA and Service Agreement
router.post('/clients/:clientId/generate-documents', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;

    // Get client and pharmacy info
    const result = await db.query(`
      SELECT c.client_name, c.submitter_email, p.pharmacy_name, p.state
      FROM clients c
      LEFT JOIN pharmacies p ON p.client_id = c.client_id
      WHERE c.client_id = $1
    `, [clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = result.rows[0];
    const pharmacyName = client.pharmacy_name || client.client_name;

    // Generate documents
    const documents = await generateOnboardingDocuments({
      pharmacyName,
      companyName: client.client_name,
      email: client.submitter_email,
      state: client.state,
    });

    console.log(`Generated documents for ${pharmacyName}`);

    res.json({
      success: true,
      documents: {
        baa: {
          filename: documents.baaFilename,
          base64: documents.baa.toString('base64'),
        },
        serviceAgreement: {
          filename: documents.serviceAgreementFilename,
          base64: documents.serviceAgreement.toString('base64'),
        },
      },
    });
  } catch (error) {
    console.error('Generate documents error:', error);
    res.status(500).json({ error: 'Failed to generate documents: ' + error.message });
  }
});

// POST /api/admin/clients/:clientId/send-welcome-email - Send welcome email with credentials
router.post('/clients/:clientId/send-welcome-email', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { includeDocuments = true, resetPassword = false, testEmail = null } = req.body;
    const isTestMode = !!testEmail;

    // Get client, pharmacy, and user info
    const result = await db.query(`
      SELECT
        c.client_name, c.submitter_email,
        p.pharmacy_name,
        u.user_id, u.email, u.first_name
      FROM clients c
      LEFT JOIN pharmacies p ON p.client_id = c.client_id
      LEFT JOIN users u ON u.client_id = c.client_id AND u.role = 'admin'
      WHERE c.client_id = $1
    `, [clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = result.rows[0];
    const pharmacyName = client.pharmacy_name || client.client_name;
    const clientEmail = client.email || client.submitter_email;
    const recipientEmail = isTestMode ? testEmail : clientEmail;

    if (!recipientEmail) {
      return res.status(400).json({ error: 'No email address provided' });
    }

    // Generate new password if requested (but NOT in test mode - we don't want to reset real passwords)
    let tempPassword = null;
    if (!isTestMode && (resetPassword || !client.user_id)) {
      tempPassword = `Welcome${Math.random().toString(36).slice(2, 8)}!`;
      const passwordHash = await bcrypt.hash(tempPassword, 12);

      if (client.user_id) {
        await db.query(
          'UPDATE users SET password_hash = $1, must_change_password = true WHERE user_id = $2',
          [passwordHash, client.user_id]
        );
      }
    }

    // In test mode, show a sample password format
    if (isTestMode) {
      tempPassword = 'WelcomeXXXXXX! (sample - not a real password)';
    }

    // Generate documents if requested
    let documents = null;
    if (includeDocuments) {
      try {
        documents = await generateOnboardingDocuments({
          pharmacyName,
          companyName: client.client_name,
          email,
        });
      } catch (docError) {
        console.error('Document generation failed:', docError.message);
      }
    }

    // Send welcome email
    const emailResult = await sendWelcomeEmail({
      to: recipientEmail,
      pharmacyName,
      tempPassword: tempPassword || '(use your existing password)',
      baaDocument: documents?.baa,
      baaFilename: documents?.baaFilename,
      serviceAgreement: documents?.serviceAgreement,
      serviceAgreementFilename: documents?.serviceAgreementFilename,
    });

    if (emailResult.success) {
      const modeLabel = isTestMode ? '[TEST] ' : '';
      console.log(`${modeLabel}Welcome email sent to ${recipientEmail} for ${pharmacyName}`);
      res.json({
        success: true,
        message: `${modeLabel}Welcome email sent to ${recipientEmail}`,
        messageId: emailResult.messageId,
        passwordReset: !isTestMode && !!tempPassword,
        isTest: isTestMode,
      });
    } else {
      // Email failed - in test mode, return preview HTML so user can still see what it looks like
      if (isTestMode) {
        res.json({
          success: false,
          error: emailResult.error,
          message: 'Email transport not configured - showing preview instead',
          isTest: true,
          preview: {
            to: recipientEmail,
            subject: `Welcome to TheRxOS - ${pharmacyName} Account Ready`,
            pharmacyName,
            tempPassword,
            hasDocuments: !!documents,
          },
        });
      } else {
        // Real send failed - return temp password for manual follow-up
        res.json({
          success: false,
          error: emailResult.error,
          tempPassword: tempPassword,
          message: 'Email failed - use temp password for manual follow-up',
        });
      }
    }
  } catch (error) {
    console.error('Send welcome email error:', error);
    res.status(500).json({ error: 'Failed to send welcome email: ' + error.message });
  }
});

// POST /api/admin/clients/:clientId/create-checkout - Create Stripe checkout link for client
router.post('/clients/:clientId/create-checkout', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const { clientId } = req.params;

    // Get client info
    const result = await db.query(`
      SELECT c.client_name, c.submitter_email, p.pharmacy_name
      FROM clients c
      LEFT JOIN pharmacies p ON p.client_id = c.client_id
      WHERE c.client_id = $1
    `, [clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = result.rows[0];
    const pharmacyName = client.pharmacy_name || client.client_name;
    const email = client.submitter_email;

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      metadata: {
        clientId,
        pharmacyName,
        adminCreated: 'true',
      },
      success_url: `https://beta.therxos.com/login?checkout=success`,
      cancel_url: `https://beta.therxos.com/login?checkout=cancelled`,
    });

    console.log(`Created Stripe checkout for ${pharmacyName}: ${session.url}`);

    res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    console.error('Create checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout: ' + error.message });
  }
});

// POST /api/admin/clients/create-onboarding - Create a new client in onboarding status
router.post('/clients/create-onboarding', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyName, email, firstName, lastName, sendEmail = true } = req.body;

    if (!pharmacyName || !email) {
      return res.status(400).json({ error: 'pharmacyName and email are required' });
    }

    // Check if email already exists
    const existing = await db.query('SELECT user_id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'A user with this email already exists' });
    }

    // Create client, pharmacy, and user
    const clientId = uuidv4();
    const pharmacyId = uuidv4();
    const userId = uuidv4();
    const subdomain = pharmacyName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30);
    const tempPassword = `Welcome${Math.random().toString(36).slice(2, 8)}!`;
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    await db.query(`
      INSERT INTO clients (client_id, client_name, dashboard_subdomain, submitter_email, status)
      VALUES ($1, $2, $3, $4, 'onboarding')
    `, [clientId, pharmacyName, subdomain, email]);

    await db.query(`
      INSERT INTO pharmacies (pharmacy_id, client_id, pharmacy_name, pharmacy_npi, state, pms_system)
      VALUES ($1, $2, $3, 'PENDING', 'XX', 'pending')
    `, [pharmacyId, clientId, pharmacyName]);

    await db.query(`
      INSERT INTO users (user_id, client_id, pharmacy_id, email, password_hash, first_name, last_name, role, is_active, must_change_password)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin', true, true)
    `, [userId, clientId, pharmacyId, email.toLowerCase(), passwordHash, firstName || pharmacyName.split(' ')[0], lastName || 'Admin']);

    console.log(`Created onboarding client: ${pharmacyName} (${email})`);

    // Generate documents and send email if requested
    let emailResult = null;
    if (sendEmail) {
      try {
        const documents = await generateOnboardingDocuments({
          pharmacyName,
          companyName: pharmacyName,
          email,
        });

        emailResult = await sendWelcomeEmail({
          to: email,
          pharmacyName,
          tempPassword,
          baaDocument: documents?.baa,
          baaFilename: documents?.baaFilename,
          serviceAgreement: documents?.serviceAgreement,
          serviceAgreementFilename: documents?.serviceAgreementFilename,
        });
      } catch (emailError) {
        console.error('Email/document generation failed:', emailError.message);
      }
    }

    res.json({
      success: true,
      client: {
        clientId,
        pharmacyId,
        pharmacyName,
        email,
        status: 'onboarding',
      },
      tempPassword,
      emailSent: emailResult?.success || false,
      emailError: emailResult?.error,
    });
  } catch (error) {
    console.error('Create onboarding client error:', error);
    res.status(500).json({ error: 'Failed to create client: ' + error.message });
  }
});

// POST /api/admin/pharmacies/:pharmacyId/mark-document-signed - Mark BAA or Service Agreement as signed
router.post('/pharmacies/:pharmacyId/mark-document-signed', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const { documentType } = req.body; // 'baa' or 'service_agreement'

    if (!['baa', 'service_agreement'].includes(documentType)) {
      return res.status(400).json({ error: 'Invalid document type. Must be "baa" or "service_agreement"' });
    }

    const column = documentType === 'baa' ? 'baa_signed_at' : 'service_agreement_signed_at';

    const result = await db.query(`
      UPDATE pharmacies
      SET ${column} = NOW(), updated_at = NOW()
      WHERE pharmacy_id = $1
      RETURNING pharmacy_id, ${column}
    `, [pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    console.log(`Marked ${documentType} as signed for pharmacy ${pharmacyId}`);

    res.json({
      success: true,
      signedAt: result.rows[0][column],
    });
  } catch (error) {
    console.error('Mark document signed error:', error);
    res.status(500).json({ error: 'Failed to mark document as signed: ' + error.message });
  }
});

// POST /api/admin/pharmacies/:pharmacyId/create-temp-login - Create temp login with password [firstName]1234
router.post('/pharmacies/:pharmacyId/create-temp-login', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    // Get pharmacy and client info
    const pharmacyResult = await db.query(`
      SELECT p.pharmacy_id, p.pharmacy_name, p.client_id, c.client_name, c.submitter_email
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [pharmacyId]);

    if (pharmacyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    const pharmacy = pharmacyResult.rows[0];

    // Check if user already exists for this pharmacy
    const existingUser = await db.query(`
      SELECT user_id, email, first_name, last_name FROM users
      WHERE pharmacy_id = $1 AND role = 'admin'
      ORDER BY created_at ASC
      LIMIT 1
    `, [pharmacyId]);

    let userId, email, firstName, lastName;
    const clientEmail = pharmacy.submitter_email;

    if (existingUser.rows.length > 0) {
      // Reset password for existing user
      userId = existingUser.rows[0].user_id;
      email = existingUser.rows[0].email;
      firstName = existingUser.rows[0].first_name || 'Admin';
      lastName = existingUser.rows[0].last_name || '';
    } else {
      // Create new user
      userId = uuidv4();
      email = clientEmail;
      firstName = pharmacy.pharmacy_name.split(' ')[0];
      lastName = 'Admin';

      if (!email) {
        return res.status(400).json({ error: 'No email found for this client. Please update the contact email first.' });
      }
    }

    // Generate password: [firstName]1234
    const tempPassword = `${firstName}1234`;
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    if (existingUser.rows.length > 0) {
      // Update existing user password
      await db.query(`
        UPDATE users
        SET password_hash = $1, must_change_password = true, updated_at = NOW()
        WHERE user_id = $2
      `, [passwordHash, userId]);

      console.log(`Reset temp password for user ${email}: ${tempPassword}`);
    } else {
      // Create new user
      await db.query(`
        INSERT INTO users (user_id, client_id, pharmacy_id, email, password_hash, first_name, last_name, role, is_active, must_change_password, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'admin', true, true, NOW())
      `, [userId, pharmacy.client_id, pharmacyId, email.toLowerCase(), passwordHash, firstName, lastName]);

      console.log(`Created temp login for ${email}: ${tempPassword}`);
    }

    res.json({
      success: true,
      credentials: {
        email: email.toLowerCase(),
        tempPassword,
        firstName,
        isNewUser: existingUser.rows.length === 0,
      },
      message: existingUser.rows.length > 0
        ? `Password reset for ${email}`
        : `New login created for ${email}`,
    });
  } catch (error) {
    console.error('Create temp login error:', error);
    res.status(500).json({ error: 'Failed to create temp login: ' + error.message });
  }
});

// POST /api/admin/clients/:clientId/create-stripe-customer - Create Stripe customer for client
router.post('/clients/:clientId/create-stripe-customer', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const { clientId } = req.params;

    // Get client info
    const result = await db.query(`
      SELECT c.client_id, c.client_name, c.submitter_email, c.stripe_customer_id, p.pharmacy_name
      FROM clients c
      LEFT JOIN pharmacies p ON p.client_id = c.client_id
      WHERE c.client_id = $1
    `, [clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = result.rows[0];

    // Check if customer already exists
    if (client.stripe_customer_id) {
      // Verify customer exists in Stripe
      try {
        const existingCustomer = await stripe.customers.retrieve(client.stripe_customer_id);
        if (!existingCustomer.deleted) {
          return res.json({
            success: true,
            customerId: client.stripe_customer_id,
            message: 'Stripe customer already exists',
            isExisting: true,
          });
        }
      } catch (stripeErr) {
        console.log('Existing Stripe customer not found, creating new one');
      }
    }

    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: client.submitter_email,
      name: client.pharmacy_name || client.client_name,
      metadata: {
        client_id: clientId,
        pharmacy_name: client.pharmacy_name || '',
      },
    });

    // Update client with Stripe customer ID
    await db.query(`
      UPDATE clients SET stripe_customer_id = $1, updated_at = NOW() WHERE client_id = $2
    `, [customer.id, clientId]);

    console.log(`Created Stripe customer ${customer.id} for ${client.client_name}`);

    res.json({
      success: true,
      customerId: customer.id,
      message: 'Stripe customer created successfully',
      isExisting: false,
    });
  } catch (error) {
    console.error('Create Stripe customer error:', error);
    res.status(500).json({ error: 'Failed to create Stripe customer: ' + error.message });
  }
});

// POST /api/admin/pharmacies/:pharmacyId/download-baa - Download BAA document
router.post('/pharmacies/:pharmacyId/download-baa', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    // Get pharmacy info
    const result = await db.query(`
      SELECT p.pharmacy_name, p.state, p.address, p.city, p.zip, p.phone, p.pharmacy_npi,
             c.client_name, c.submitter_email
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    const pharmacy = result.rows[0];

    // Generate BAA document
    const { generateDocument } = await import('../services/documentGenerator.js');
    const document = await generateDocument('BAA', {
      pharmacyName: pharmacy.pharmacy_name,
      companyName: pharmacy.client_name || pharmacy.pharmacy_name,
      email: pharmacy.submitter_email,
      address: pharmacy.address,
      city: pharmacy.city,
      state: pharmacy.state,
      zip: pharmacy.zip,
      phone: pharmacy.phone,
      npi: pharmacy.pharmacy_npi,
    });

    const filename = `BAA_${pharmacy.pharmacy_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(document);
  } catch (error) {
    console.error('Download BAA error:', error);
    res.status(500).json({ error: 'Failed to generate BAA: ' + error.message });
  }
});

// POST /api/admin/pharmacies/:pharmacyId/download-onboarding-guide - Download Onboarding Guide
router.post('/pharmacies/:pharmacyId/download-onboarding-guide', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    // Get pharmacy info
    const result = await db.query(`
      SELECT p.pharmacy_name, p.state, p.address, p.city, p.zip, p.phone, p.pharmacy_npi,
             c.client_name, c.submitter_email
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    const pharmacy = result.rows[0];

    // Generate Onboarding Guide document
    const { generateDocument } = await import('../services/documentGenerator.js');
    const document = await generateDocument('OnboardingGuide', {
      pharmacyName: pharmacy.pharmacy_name,
      companyName: pharmacy.client_name || pharmacy.pharmacy_name,
      email: pharmacy.submitter_email,
      address: pharmacy.address,
      city: pharmacy.city,
      state: pharmacy.state,
      zip: pharmacy.zip,
      phone: pharmacy.phone,
      npi: pharmacy.pharmacy_npi,
    });

    const filename = `OnboardingGuide_${pharmacy.pharmacy_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(document);
  } catch (error) {
    console.error('Download Onboarding Guide error:', error);
    res.status(500).json({ error: 'Failed to generate Onboarding Guide: ' + error.message });
  }
});

// POST /api/admin/pharmacies/:pharmacyId/download-service-agreement - Download Service Agreement
router.post('/pharmacies/:pharmacyId/download-service-agreement', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    // Get pharmacy info
    const result = await db.query(`
      SELECT p.pharmacy_name, p.state, p.address, p.city, p.zip, p.phone, p.pharmacy_npi,
             c.client_name, c.submitter_email
      FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE p.pharmacy_id = $1
    `, [pharmacyId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    const pharmacy = result.rows[0];

    // Generate Service Agreement document
    const { generateDocument } = await import('../services/documentGenerator.js');
    const document = await generateDocument('ServiceAgreement', {
      pharmacyName: pharmacy.pharmacy_name,
      companyName: pharmacy.client_name || pharmacy.pharmacy_name,
      email: pharmacy.submitter_email,
      address: pharmacy.address,
      city: pharmacy.city,
      state: pharmacy.state,
      zip: pharmacy.zip,
      phone: pharmacy.phone,
      npi: pharmacy.pharmacy_npi,
    });

    const filename = `ServiceAgreement_${pharmacy.pharmacy_name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.docx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(document);
  } catch (error) {
    console.error('Download Service Agreement error:', error);
    res.status(500).json({ error: 'Failed to generate Service Agreement: ' + error.message });
  }
});

// GET /api/admin/opportunities/duplicates - Find duplicate opportunities
router.get('/opportunities/duplicates', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId } = req.query;

    // Find patients with multiple Not Submitted opportunities in same therapeutic category
    const result = await db.query(`
      WITH statin_opps AS (
        SELECT patient_id, pharmacy_id, 'Statins' as category,
               array_agg(opportunity_id ORDER BY annual_margin_gain DESC) as opp_ids,
               array_agg(recommended_drug_name ORDER BY annual_margin_gain DESC) as drugs,
               array_agg(annual_margin_gain ORDER BY annual_margin_gain DESC) as values,
               COUNT(*) as count
        FROM opportunities
        WHERE status = 'Not Submitted'
          AND (LOWER(recommended_drug_name) LIKE '%statin%'
               OR LOWER(current_drug_name) LIKE '%statin%'
               OR LOWER(recommended_drug_name) LIKE '%atorva%'
               OR LOWER(recommended_drug_name) LIKE '%rosuva%'
               OR LOWER(recommended_drug_name) LIKE '%simva%'
               OR LOWER(recommended_drug_name) LIKE '%pitava%')
          ${pharmacyId ? 'AND pharmacy_id = $1' : ''}
        GROUP BY patient_id, pharmacy_id
        HAVING COUNT(*) > 1
      ),
      diabetes_supplies AS (
        SELECT patient_id, pharmacy_id, 'Diabetes Supplies' as category,
               array_agg(opportunity_id ORDER BY annual_margin_gain DESC) as opp_ids,
               array_agg(recommended_drug_name ORDER BY annual_margin_gain DESC) as drugs,
               array_agg(annual_margin_gain ORDER BY annual_margin_gain DESC) as values,
               COUNT(*) as count
        FROM opportunities
        WHERE status = 'Not Submitted'
          AND (LOWER(recommended_drug_name) LIKE '%lancet%'
               OR LOWER(recommended_drug_name) LIKE '%pen needle%'
               OR LOWER(recommended_drug_name) LIKE '%test strip%')
          ${pharmacyId ? 'AND pharmacy_id = $1' : ''}
        GROUP BY patient_id, pharmacy_id
        HAVING COUNT(*) > 1
      ),
      all_duplicates AS (
        SELECT * FROM statin_opps
        UNION ALL
        SELECT * FROM diabetes_supplies
      )
      SELECT
        ad.*,
        p.first_name || ' ' || p.last_name as patient_name,
        p.dob,
        ph.pharmacy_name
      FROM all_duplicates ad
      JOIN patients p ON p.patient_id = ad.patient_id
      JOIN pharmacies ph ON ph.pharmacy_id = ad.pharmacy_id
      ORDER BY ad.count DESC, ad.category
      LIMIT 100
    `, pharmacyId ? [pharmacyId] : []);

    // Calculate summary
    const totalDuplicates = result.rows.reduce((sum, r) => sum + (r.count - 1), 0);
    const inflatedMargin = result.rows.reduce((sum, r) => {
      const values = r.values || [];
      return sum + values.slice(1).reduce((s, v) => s + (parseFloat(v) || 0), 0);
    }, 0);

    res.json({
      duplicates: result.rows,
      summary: {
        patientsAffected: result.rows.length,
        totalDuplicateOpportunities: totalDuplicates,
        inflatedMargin: inflatedMargin.toFixed(2)
      }
    });
  } catch (error) {
    console.error('Find duplicates error:', error);
    res.status(500).json({ error: 'Failed to find duplicates: ' + error.message });
  }
});

// POST /api/admin/opportunities/deduplicate - Remove duplicate opportunities, keeping highest value
router.post('/opportunities/deduplicate', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyId, dryRun = true } = req.body;

    // Define therapeutic categories for deduplication
    const categories = [
      {
        name: 'Statins',
        patterns: ['statin', 'atorva', 'rosuva', 'simva', 'pitava', 'prava', 'fluva', 'lova']
      },
      {
        name: 'Diabetes Supplies - Lancets',
        patterns: ['lancet']
      },
      {
        name: 'Diabetes Supplies - Pen Needles',
        patterns: ['pen needle', 'penneedle']
      },
      {
        name: 'Diabetes Supplies - Test Strips',
        patterns: ['test strip', 'glucose strip']
      },
      {
        name: 'ACE Inhibitors',
        patterns: ['lisinopril', 'enalapril', 'ramipril', 'benazepril', 'captopril']
      },
      {
        name: 'ARBs',
        patterns: ['losartan', 'valsartan', 'irbesartan', 'olmesartan', 'candesartan']
      }
    ];

    const results = [];
    let totalRemoved = 0;
    let totalMarginReduction = 0;

    for (const category of categories) {
      const patternConditions = category.patterns
        .map((_, i) => `LOWER(recommended_drug_name) LIKE '%' || $${i + 1} || '%' OR LOWER(current_drug_name) LIKE '%' || $${i + 1} || '%'`)
        .join(' OR ');

      // Find duplicate groups
      const duplicatesResult = await db.query(`
        SELECT patient_id, pharmacy_id,
               array_agg(opportunity_id ORDER BY annual_margin_gain DESC NULLS LAST) as opp_ids,
               array_agg(annual_margin_gain ORDER BY annual_margin_gain DESC NULLS LAST) as values
        FROM opportunities
        WHERE status = 'Not Submitted'
          AND (${patternConditions})
          ${pharmacyId ? `AND pharmacy_id = $${category.patterns.length + 1}` : ''}
        GROUP BY patient_id, pharmacy_id
        HAVING COUNT(*) > 1
      `, [...category.patterns, ...(pharmacyId ? [pharmacyId] : [])]);

      for (const dup of duplicatesResult.rows) {
        const keepId = dup.opp_ids[0]; // Keep highest value
        const removeIds = dup.opp_ids.slice(1);
        const removedMargin = dup.values.slice(1).reduce((s, v) => s + (parseFloat(v) || 0), 0);

        results.push({
          category: category.name,
          patientId: dup.patient_id,
          pharmacyId: dup.pharmacy_id,
          keptOpportunityId: keepId,
          keptValue: dup.values[0],
          removedCount: removeIds.length,
          removedMargin
        });

        totalRemoved += removeIds.length;
        totalMarginReduction += removedMargin;

        // Actually delete if not dry run
        if (!dryRun && removeIds.length > 0) {
          await db.query(
            `DELETE FROM opportunities WHERE opportunity_id = ANY($1)`,
            [removeIds]
          );
        }
      }
    }

    res.json({
      dryRun,
      summary: {
        categoriesChecked: categories.length,
        patientsAffected: results.length,
        opportunitiesRemoved: totalRemoved,
        marginReduction: totalMarginReduction.toFixed(2)
      },
      details: results.slice(0, 50), // Limit details for response size
      message: dryRun
        ? `Would remove ${totalRemoved} duplicate opportunities, reducing margin by $${totalMarginReduction.toFixed(2)}`
        : `Removed ${totalRemoved} duplicate opportunities, reducing margin by $${totalMarginReduction.toFixed(2)}`
    });
  } catch (error) {
    console.error('Deduplicate error:', error);
    res.status(500).json({ error: 'Failed to deduplicate: ' + error.message });
  }
});

// ==========================================
// NEGATIVE GP OPPORTUNITY DISCOVERY
// ==========================================

// GET /api/admin/negative-gp-losers - Preview negative GP drugs without submitting
router.get('/negative-gp-losers', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const {
      minFills = 3,
      maxAvgGP = -2.00,
      lookbackDays = 180,
      limit = 100
    } = req.query;

    const { findNegativeGPDrugs } = await import('../services/negative-gp-scanner.js');

    const losers = await findNegativeGPDrugs({
      lookbackDays: parseInt(lookbackDays),
      minFillsNegative: parseInt(minFills),
      maxAvgGP: parseFloat(maxAvgGP)
    });

    res.json({
      losers: losers.slice(0, parseInt(limit)).map(r => ({
        ...r,
        avg_gp: parseFloat(r.avg_gp),
        total_loss: parseFloat(r.total_loss),
        worst_gp: parseFloat(r.worst_gp),
        best_gp: parseFloat(r.best_gp),
        fill_count: parseInt(r.fill_count),
        patient_count: parseInt(r.patient_count),
        pharmacy_count: parseInt(r.pharmacy_count)
      })),
      count: losers.length,
      thresholds: {
        minFills: parseInt(minFills),
        maxAvgGP: parseFloat(maxAvgGP),
        lookbackDays: parseInt(lookbackDays)
      }
    });
  } catch (error) {
    console.error('Negative GP losers error:', error);
    res.status(500).json({ error: 'Failed to get negative GP losers: ' + error.message });
  }
});

// POST /api/admin/scan-negative-gp - Run full negative GP scan and submit to approval queue
router.post('/scan-negative-gp', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const {
      minFillsNegative = 3,
      maxAvgGP = -2.00,
      minFillsAlternative = 2,
      minAvgGPAlternative = 5.00,
      lookbackDays = 180,
      minMarginGain = 10.00,
      maxResults = 50
    } = req.body;

    const { scanNegativeGPOpportunities } = await import('../services/negative-gp-scanner.js');

    const results = await scanNegativeGPOpportunities({
      minFillsNegative: parseInt(minFillsNegative),
      maxAvgGP: parseFloat(maxAvgGP),
      minFillsAlternative: parseInt(minFillsAlternative),
      minAvgGPAlternative: parseFloat(minAvgGPAlternative),
      lookbackDays: parseInt(lookbackDays),
      minMarginGain: parseFloat(minMarginGain),
      maxResults: parseInt(maxResults)
    });

    res.json({
      success: true,
      ...results
    });
  } catch (error) {
    console.error('Negative GP scan error:', error);
    res.status(500).json({ error: 'Failed to scan for negative GP opportunities: ' + error.message });
  }
});

// ==========================================
// POSITIVE GP SCAN (Top Winners)
// ==========================================

// GET /api/admin/positive-gp-winners - Find drugs with highest positive GP by BIN/GROUP
router.get('/positive-gp-winners', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const {
      minFills = 3,
      minAvgGP = 10,
      lookbackDays = 180,
      limit = 100
    } = req.query;

    // Find best NDC per drug/BIN/GROUP combo and detect if NDCs have identical reimbursement
    const result = await db.query(`
      WITH per_ndc AS (
        SELECT
          UPPER(TRIM(p.drug_name)) as normalized_drug,
          p.drug_name,
          p.ndc,
          p.insurance_bin,
          p.insurance_group,
          COUNT(*) as fill_count,
          COUNT(DISTINCT p.patient_id) as patient_count,
          COUNT(DISTINCT p.pharmacy_id) as pharmacy_count,
          ROUND(AVG(
            COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric,
              0)
          )::numeric, 2) as avg_gp,
          ROUND(SUM(
            COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric,
              0)
          )::numeric, 2) as total_profit,
          ROUND(MAX(
            COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric,
              0)
          )::numeric, 2) as best_gp,
          ROUND(AVG(COALESCE(p.acquisition_cost, 0))::numeric, 2) as avg_acq_cost,
          ROUND(AVG(COALESCE(p.patient_pay, 0) + COALESCE(p.insurance_pay, 0))::numeric, 2) as avg_reimbursement
        FROM prescriptions p
        JOIN pharmacies ph ON ph.pharmacy_id = p.pharmacy_id
        JOIN clients c ON c.client_id = ph.client_id AND c.status != 'demo'
        WHERE p.dispensed_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
          AND p.acquisition_cost IS NOT NULL
          AND p.acquisition_cost > 0
          AND p.insurance_bin IS NOT NULL
          AND p.insurance_bin NOT IN ('000000', '000001', '999999', '')
          AND (p.insurance_group IS NULL OR p.insurance_group NOT IN ('No Group Number', 'NO GROUP', 'NONE', 'N/A', ''))
          AND (p.insurance_pay IS NOT NULL OR p.patient_pay IS NOT NULL)
        GROUP BY UPPER(TRIM(p.drug_name)), p.drug_name, p.ndc, p.insurance_bin, p.insurance_group
        HAVING COUNT(*) >= 1
      ),
      ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY normalized_drug, insurance_bin, COALESCE(insurance_group, '') ORDER BY avg_gp DESC) as rank,
          COUNT(DISTINCT ndc) OVER (PARTITION BY normalized_drug, insurance_bin, COALESCE(insurance_group, '')) as ndc_count,
          MAX(avg_gp) OVER (PARTITION BY normalized_drug, insurance_bin, COALESCE(insurance_group, '')) -
          MIN(avg_gp) OVER (PARTITION BY normalized_drug, insurance_bin, COALESCE(insurance_group, '')) as gp_spread
        FROM per_ndc
      ),
      best_per_combo AS (
        SELECT
          normalized_drug as base_drug_name,
          drug_name,
          ndc as best_ndc,
          insurance_bin,
          insurance_group,
          SUM(fill_count) OVER w as fill_count,
          SUM(patient_count) OVER w as patient_count,
          MAX(pharmacy_count) OVER w as pharmacy_count,
          avg_gp,
          SUM(total_profit) OVER w as total_profit,
          best_gp,
          avg_acq_cost,
          avg_reimbursement,
          ndc_count,
          CASE WHEN ndc_count <= 1 OR gp_spread < 2 THEN true ELSE false END as ndc_doesnt_matter
        FROM ranked
        WHERE rank = 1
        WINDOW w AS (PARTITION BY normalized_drug, insurance_bin, COALESCE(insurance_group, ''))
      )
      SELECT * FROM best_per_combo
      WHERE fill_count >= $2
        AND avg_gp >= $3
      ORDER BY avg_gp DESC
      LIMIT $4
    `, [parseInt(lookbackDays), parseInt(minFills), parseFloat(minAvgGP), parseInt(limit)]);

    const totalProfit = result.rows.reduce((sum, r) => sum + parseFloat(r.total_profit), 0);
    const totalPatients = result.rows.reduce((sum, r) => sum + parseInt(r.patient_count), 0);

    res.json({
      winners: result.rows.map(r => ({
        ...r,
        avg_gp: parseFloat(r.avg_gp),
        total_profit: parseFloat(r.total_profit),
        best_gp: parseFloat(r.best_gp),
        avg_acq_cost: parseFloat(r.avg_acq_cost),
        avg_reimbursement: parseFloat(r.avg_reimbursement),
        fill_count: parseInt(r.fill_count),
        patient_count: parseInt(r.patient_count),
        pharmacy_count: parseInt(r.pharmacy_count),
        best_ndc: r.best_ndc || null,
        ndc_doesnt_matter: r.ndc_doesnt_matter || false
      })),
      count: result.rows.length,
      totalProfit,
      totalPatients,
      thresholds: {
        minFills: parseInt(minFills),
        minAvgGP: parseFloat(minAvgGP),
        lookbackDays: parseInt(lookbackDays)
      }
    });
  } catch (error) {
    console.error('Positive GP winners error:', error);
    res.status(500).json({ error: 'Failed to get positive GP winners: ' + error.message });
  }
});

// ==========================================
// NDC OPTIMIZATION SCAN
// ==========================================

// GET /api/admin/ndc-optimization - Find same-drug NDCs with better reimbursement on same BIN/GROUP
router.get('/ndc-optimization', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const {
      minFills = 3,
      minGPDifference = 3,
      lookbackDays = 180,
      limit = 100
    } = req.query;

    // Find drugs where different NDCs of the same drug+strength+form have different GP on the same BIN/GROUP
    // Normalizes drug names to extract base drug + strength + formulation to prevent cross-strength/form matches
    // e.g., "Tramadol HCl ER 100mg" and "Tramadol HCl 50mg Tab" are DIFFERENT drugs, not NDC optimization candidates
    const result = await db.query(`
      WITH drug_ndc_gp AS (
        SELECT
          -- Normalize: full drug name uppercased as the match key (includes strength + form)
          -- This prevents matching different strengths or formulations as "same drug"
          UPPER(TRIM(p.drug_name)) as normalized_drug,
          p.drug_name,
          p.ndc,
          p.insurance_bin,
          p.insurance_group,
          COUNT(*) as fill_count,
          COUNT(DISTINCT p.patient_id) as patient_count,
          ROUND(AVG(
            COALESCE((p.raw_data->>'gross_profit')::numeric, (p.raw_data->>'net_profit')::numeric, (p.raw_data->>'Gross Profit')::numeric, (p.raw_data->>'Net Profit')::numeric,
              0)
          )::numeric, 2) as avg_gp,
          ROUND(AVG(COALESCE(p.acquisition_cost, 0))::numeric, 2) as avg_acq_cost,
          ROUND(AVG(COALESCE(p.patient_pay, 0) + COALESCE(p.insurance_pay, 0))::numeric, 2) as avg_reimbursement
        FROM prescriptions p
        JOIN pharmacies ph ON ph.pharmacy_id = p.pharmacy_id
        JOIN clients c ON c.client_id = ph.client_id AND c.status != 'demo'
        WHERE p.dispensed_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
          AND p.acquisition_cost IS NOT NULL
          AND p.acquisition_cost > 0
          AND p.insurance_bin IS NOT NULL
          AND p.insurance_bin NOT IN ('000000', '000001', '999999', '')
          AND (p.insurance_group IS NULL OR p.insurance_group NOT IN ('No Group Number', 'NO GROUP', 'NONE', 'N/A', ''))
          AND p.ndc IS NOT NULL
          AND (p.insurance_pay IS NOT NULL OR p.patient_pay IS NOT NULL)
        GROUP BY UPPER(TRIM(p.drug_name)), p.drug_name, p.ndc, p.insurance_bin, p.insurance_group
        HAVING COUNT(*) >= $2
      ),
      ndc_pairs AS (
        SELECT
          low.normalized_drug as base_drug,
          low.drug_name as current_drug,
          low.ndc as current_ndc,
          high.drug_name as better_drug,
          high.ndc as better_ndc,
          low.insurance_bin,
          low.insurance_group,
          low.fill_count as current_fills,
          low.patient_count as current_patients,
          low.avg_gp as current_avg_gp,
          low.avg_acq_cost as current_acq_cost,
          low.avg_reimbursement as current_reimbursement,
          high.fill_count as better_fills,
          high.avg_gp as better_avg_gp,
          high.avg_acq_cost as better_acq_cost,
          high.avg_reimbursement as better_reimbursement,
          (high.avg_gp - low.avg_gp) as gp_difference,
          (high.avg_gp - low.avg_gp) * 12 as annual_gain_per_patient
        FROM drug_ndc_gp low
        JOIN drug_ndc_gp high
          ON low.normalized_drug = high.normalized_drug
          AND low.insurance_bin = high.insurance_bin
          AND COALESCE(low.insurance_group, '') = COALESCE(high.insurance_group, '')
          AND low.ndc != high.ndc
          AND high.avg_gp > low.avg_gp
        WHERE (high.avg_gp - low.avg_gp) >= $3
      )
      SELECT * FROM ndc_pairs
      ORDER BY gp_difference DESC
      LIMIT $4
    `, [parseInt(lookbackDays), parseInt(minFills), parseFloat(minGPDifference), parseInt(limit)]);

    res.json({
      opportunities: result.rows.map(r => ({
        ...r,
        current_avg_gp: parseFloat(r.current_avg_gp),
        better_avg_gp: parseFloat(r.better_avg_gp),
        gp_difference: parseFloat(r.gp_difference),
        annual_gain_per_patient: parseFloat(r.annual_gain_per_patient),
        current_acq_cost: parseFloat(r.current_acq_cost),
        better_acq_cost: parseFloat(r.better_acq_cost),
        current_reimbursement: parseFloat(r.current_reimbursement),
        better_reimbursement: parseFloat(r.better_reimbursement),
        current_fills: parseInt(r.current_fills),
        current_patients: parseInt(r.current_patients),
        better_fills: parseInt(r.better_fills)
      })),
      count: result.rows.length,
      thresholds: {
        minFills: parseInt(minFills),
        minGPDifference: parseFloat(minGPDifference),
        lookbackDays: parseInt(lookbackDays)
      }
    });
  } catch (error) {
    console.error('NDC optimization error:', error);
    res.status(500).json({ error: 'Failed to get NDC optimization data: ' + error.message });
  }
});

// PATCH /api/admin/pharmacies/:id/fax-settings - Toggle fax for a pharmacy
router.patch('/pharmacies/:id/fax-settings', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { faxEnabled, autoFaxEnabled, autoFaxTypes } = req.body;

    // Build the settings update object (only include provided fields)
    const faxSettings = {};
    if (faxEnabled !== undefined) faxSettings.faxEnabled = faxEnabled;
    if (autoFaxEnabled !== undefined) faxSettings.autoFaxEnabled = autoFaxEnabled;
    if (autoFaxTypes !== undefined) faxSettings.autoFaxTypes = autoFaxTypes;

    // Merge into existing JSONB settings
    const result = await db.query(`
      UPDATE pharmacies
      SET settings = COALESCE(settings, '{}'::jsonb) || $1::jsonb,
          updated_at = NOW()
      WHERE pharmacy_id = $2
      RETURNING pharmacy_id, pharmacy_name, settings
    `, [JSON.stringify(faxSettings), id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    logger.info('Pharmacy fax settings updated', {
      pharmacyId: id,
      faxSettings,
      updatedBy: req.user.userId
    });

    res.json({
      success: true,
      pharmacy: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating fax settings:', error);
    res.status(500).json({ error: 'Failed to update fax settings' });
  }
});

// GET /api/admin/fax-overview - Platform-wide fax stats for admin dashboard
router.get('/fax-overview', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const interval = `${days} days`;

    const [overall, byPharmacy] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) as total_sent,
          COUNT(*) FILTER (WHERE fax_status = 'successful') as delivered,
          COUNT(*) FILTER (WHERE fax_status = 'failed') as failed,
          COALESCE(SUM(cost_cents), 0) as total_cost_cents,
          COALESCE(SUM(page_count), 0) as total_pages
        FROM fax_log
        WHERE sent_at >= NOW() - INTERVAL '${interval}'
      `),
      db.query(`
        SELECT ph.pharmacy_name, ph.pharmacy_id,
          COUNT(*) as faxes_sent,
          COUNT(*) FILTER (WHERE fl.fax_status = 'successful') as delivered,
          COALESCE(SUM(fl.cost_cents), 0) as cost_cents
        FROM fax_log fl
        JOIN pharmacies ph ON ph.pharmacy_id = fl.pharmacy_id
        WHERE fl.sent_at >= NOW() - INTERVAL '${interval}'
        GROUP BY ph.pharmacy_id, ph.pharmacy_name
        ORDER BY faxes_sent DESC
      `)
    ]);

    res.json({
      overall: overall.rows[0],
      byPharmacy: byPharmacy.rows
    });
  } catch (error) {
    console.error('Fax overview error:', error);
    res.status(500).json({ error: 'Failed to get fax overview' });
  }
});

export default router;
