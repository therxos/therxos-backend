// admin.js - Super Admin API routes for platform management
import express from 'express';
import jwt from 'jsonwebtoken';
import db from '../database/index.js';
import { authenticateToken } from '../middleware/auth.js';
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
    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM pharmacies) as total_pharmacies,
        (SELECT COUNT(*) FROM pharmacies p JOIN clients c ON c.client_id = p.client_id WHERE c.status = 'active') as active_pharmacies,
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM opportunities) as total_opportunities,
        (SELECT COALESCE(SUM(annual_margin_gain), 0) FROM opportunities) as total_value,
        (SELECT COALESCE(SUM(annual_margin_gain), 0) FROM opportunities WHERE status IN ('Completed', 'Approved')) as captured_value
    `);
    
    // Calculate MRR (assume $299/mo per active pharmacy)
    const mrr = (stats.rows[0]?.active_pharmacies || 0) * 299;
    
    res.json({
      ...stats.rows[0],
      mrr,
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
    
    // Get the pharmacy's admin user
    const userResult = await db.query(`
      SELECT u.*, p.pharmacy_name, c.client_name
      FROM users u
      JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id
      JOIN clients c ON c.client_id = u.client_id
      WHERE u.pharmacy_id = $1 AND u.role = 'admin'
      LIMIT 1
    `, [pharmacy_id]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy admin not found' });
    }
    
    const targetUser = userResult.rows[0];
    
    // Create impersonation token with super admin's original user ID
    const token = jwt.sign(
      {
        userId: targetUser.user_id,
        email: targetUser.email,
        pharmacyId: targetUser.pharmacy_id,
        clientId: targetUser.client_id,
        role: targetUser.role,
        firstName: targetUser.first_name,
        lastName: targetUser.last_name,
        pharmacyName: targetUser.pharmacy_name,
        impersonatedBy: req.user.userId, // Track who is impersonating
      },
      process.env.JWT_SECRET,
      { expiresIn: '4h' }
    );
    
    // Log impersonation
    console.log(`Super admin ${req.user.email} impersonating ${targetUser.email} at ${targetUser.pharmacy_name}`);
    
    res.json({
      token,
      user: {
        userId: targetUser.user_id,
        email: targetUser.email,
        firstName: targetUser.first_name,
        lastName: targetUser.last_name,
        role: targetUser.role,
        pharmacyId: targetUser.pharmacy_id,
        pharmacyName: targetUser.pharmacy_name,
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

export default router;
