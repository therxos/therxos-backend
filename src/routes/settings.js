// Pharmacy settings routes for TheRxOS V2
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken, requireRole } from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Parse CSV line handling quoted values
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Load triggers from CSV
function loadTriggersFromCSV() {
  const csvPath = path.join(__dirname, '../../UNIVERSAL_TRIGGER.csv');

  if (!fs.existsSync(csvPath)) {
    logger.warn('Triggers CSV not found', { path: csvPath });
    return [];
  }

  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.trim().split('\n');
  const headers = parseCSVLine(lines[0]);

  const triggers = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const values = parseCSVLine(lines[i]);
    const trigger = {};
    headers.forEach((header, idx) => {
      trigger[header.trim()] = values[idx] || '';
    });

    triggers.push({
      triggerId: trigger['Trigger ID'],
      displayName: trigger['Display Name'],
      category: trigger['Category'] || 'Other',
      priority: trigger['Priority'] || 'MEDIUM',
      recommendedMed: trigger['Recommended Med'],
      action: trigger['Action'],
      globalEnabled: trigger['Enabled']?.toUpperCase() === 'TRUE'
    });
  }

  return triggers;
}

// Get available triggers list (from database)
router.get('/triggers', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT trigger_id, trigger_code, display_name, trigger_type,
             category, recommended_drug, priority, is_enabled
      FROM triggers
      WHERE is_enabled = true
      ORDER BY category, display_name
    `);

    const triggers = result.rows.map(t => ({
      triggerId: t.trigger_id,
      triggerCode: t.trigger_code,
      displayName: t.display_name,
      category: t.category || t.trigger_type || 'Other',
      priority: (t.priority || 'medium').toUpperCase(),
      recommendedMed: t.recommended_drug,
      globalEnabled: t.is_enabled
    }));

    // Group by category
    const grouped = {};
    for (const trigger of triggers) {
      const cat = trigger.category || 'Other';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(trigger);
    }

    res.json({
      triggers,
      grouped,
      categories: Object.keys(grouped).sort()
    });
  } catch (error) {
    logger.error('Get triggers error', { error: error.message });
    res.status(500).json({ error: 'Failed to get triggers' });
  }
});

// Get current user's pharmacy info (for fax generation, etc.)
router.get('/pharmacy-info', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT pharmacy_id, pharmacy_name, pharmacy_npi as npi, ncpdp,
              address, city, state, zip, phone, fax
       FROM pharmacies WHERE pharmacy_id = $1`,
      [req.user.pharmacyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    res.json({ pharmacy: result.rows[0] });
  } catch (error) {
    logger.error('Get pharmacy info error', { error: error.message });
    res.status(500).json({ error: 'Failed to get pharmacy info' });
  }
});

// Get pharmacy settings
router.get('/pharmacy/:pharmacyId', authenticateToken, async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    // Ensure user belongs to this pharmacy or is super admin
    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(
      'SELECT settings FROM pharmacies WHERE pharmacy_id = $1',
      [pharmacyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    // Default settings if none exist
    const defaultSettings = {
      enabledOpportunityTypes: {
        missing_therapy: true,
        therapeutic_interchange: true,
        ndc_optimization: true
      }
    };

    res.json(result.rows[0].settings || defaultSettings);
  } catch (error) {
    logger.error('Get pharmacy settings error', { error: error.message });
    res.status(500).json({ error: 'Failed to get settings' });
  }
});

// Update pharmacy settings
router.put('/pharmacy/:pharmacyId', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const { settings } = req.body;

    // Ensure user belongs to this pharmacy
    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(
      'UPDATE pharmacies SET settings = $1, updated_at = NOW() WHERE pharmacy_id = $2 RETURNING settings',
      [JSON.stringify(settings), pharmacyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    logger.info('Pharmacy settings updated', { pharmacyId, userId: req.user.userId });
    res.json(result.rows[0].settings);
  } catch (error) {
    logger.error('Update pharmacy settings error', { error: error.message });
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Get excluded prescribers
router.get('/pharmacy/:pharmacyId/excluded-prescribers', authenticateToken, async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(
      `SELECT ep.*, u.first_name as created_by_first, u.last_name as created_by_last
       FROM excluded_prescribers ep
       LEFT JOIN users u ON u.user_id = ep.created_by
       WHERE ep.pharmacy_id = $1
       ORDER BY ep.prescriber_name`,
      [pharmacyId]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Get excluded prescribers error', { error: error.message });
    res.status(500).json({ error: 'Failed to get excluded prescribers' });
  }
});

// Add excluded prescriber
router.post('/pharmacy/:pharmacyId/excluded-prescribers', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const { prescriberName, prescriberNpi, prescriberDea, reason } = req.body;

    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!prescriberName) {
      return res.status(400).json({ error: 'Prescriber name is required' });
    }

    if (!prescriberNpi && !prescriberDea) {
      return res.status(400).json({ error: 'Either NPI or DEA is required' });
    }

    const result = await db.query(
      `INSERT INTO excluded_prescribers (pharmacy_id, prescriber_name, prescriber_npi, prescriber_dea, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [pharmacyId, prescriberName, prescriberNpi || null, prescriberDea || null, reason || null, req.user.userId]
    );

    logger.info('Excluded prescriber added', { pharmacyId, prescriberName, userId: req.user.userId });
    res.status(201).json(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') { // Unique violation
      return res.status(409).json({ error: 'This prescriber is already excluded' });
    }
    logger.error('Add excluded prescriber error', { error: error.message });
    res.status(500).json({ error: 'Failed to add excluded prescriber' });
  }
});

// Remove excluded prescriber
router.delete('/pharmacy/:pharmacyId/excluded-prescribers/:id', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { pharmacyId, id } = req.params;

    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(
      'DELETE FROM excluded_prescribers WHERE id = $1 AND pharmacy_id = $2 RETURNING *',
      [id, pharmacyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Excluded prescriber not found' });
    }

    logger.info('Excluded prescriber removed', { pharmacyId, id, userId: req.user.userId });
    res.json({ success: true });
  } catch (error) {
    logger.error('Remove excluded prescriber error', { error: error.message });
    res.status(500).json({ error: 'Failed to remove excluded prescriber' });
  }
});

// Get pharmacy users (for user management)
router.get('/pharmacy/:pharmacyId/users', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(
      `SELECT user_id, email, first_name, last_name, role, is_active, last_login_at, created_at
       FROM users
       WHERE pharmacy_id = $1
       ORDER BY created_at DESC`,
      [pharmacyId]
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Get pharmacy users error', { error: error.message });
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// Create new user (for pharmacy admins)
router.post('/pharmacy/:pharmacyId/users', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const { email, firstName, lastName, role } = req.body;

    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate role - admins can create pharmacist, technician
    const allowedRoles = ['pharmacist', 'technician'];
    if (req.user.role === 'super_admin') {
      allowedRoles.push('admin');
    }

    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if email already exists
    const existing = await db.query('SELECT user_id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    // Get pharmacy info for client_id
    const pharmacy = await db.query('SELECT client_id, pharmacy_name FROM pharmacies WHERE pharmacy_id = $1', [pharmacyId]);
    if (pharmacy.rows.length === 0) {
      return res.status(404).json({ error: 'Pharmacy not found' });
    }

    // Generate password
    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, 12);

    const userId = uuidv4();
    await db.query(
      `INSERT INTO users (user_id, client_id, pharmacy_id, email, password_hash, first_name, last_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
      [userId, pharmacy.rows[0].client_id, pharmacyId, email.toLowerCase(), passwordHash, firstName, lastName, role]
    );

    logger.info('New user created', { userId, email, role, pharmacyId, createdBy: req.user.userId });

    // Return user info with password (will be emailed to them)
    res.status(201).json({
      userId,
      email: email.toLowerCase(),
      firstName,
      lastName,
      role,
      password, // This will be sent to the user
      pharmacyName: pharmacy.rows[0].pharmacy_name
    });
  } catch (error) {
    logger.error('Create user error', { error: error.message });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user (deactivate, change role)
router.patch('/pharmacy/:pharmacyId/users/:userId', authenticateToken, requireRole('super_admin', 'admin'), async (req, res) => {
  try {
    const { pharmacyId, userId } = req.params;
    const { role, isActive } = req.body;

    if (req.user.pharmacyId !== pharmacyId && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Can't modify yourself
    if (userId === req.user.userId) {
      return res.status(400).json({ error: 'Cannot modify your own account' });
    }

    const updates = [];
    const values = [];
    let paramIndex = 1;

    if (role !== undefined) {
      const allowedRoles = ['pharmacist', 'technician'];
      if (req.user.role === 'super_admin') allowedRoles.push('admin');
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
      }
      updates.push(`role = $${paramIndex++}`);
      values.push(role);
    }

    if (isActive !== undefined) {
      updates.push(`is_active = $${paramIndex++}`);
      values.push(isActive);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates provided' });
    }

    values.push(userId, pharmacyId);
    const result = await db.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE user_id = $${paramIndex++} AND pharmacy_id = $${paramIndex}
       RETURNING user_id, email, first_name, last_name, role, is_active`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    logger.info('User updated', { userId, pharmacyId, updates: req.body, updatedBy: req.user.userId });
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Update user error', { error: error.message });
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Helper to generate random password
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 12; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

export default router;
