// Client routes for TheRxOS V2
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken, requireRole } from './auth.js';

const router = express.Router();

// Get all clients (super admin)
router.get('/', authenticateToken, requireRole('owner'), async (req, res) => {
  try {
    const result = await db.query(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM pharmacies WHERE client_id = c.client_id) as pharmacy_count,
        (SELECT COUNT(*) FROM users WHERE client_id = c.client_id) as user_count
      FROM clients c
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (error) {
    logger.error('Get clients error', { error: error.message });
    res.status(500).json({ error: 'Failed to get clients' });
  }
});

// Get single client
router.get('/:clientId', authenticateToken, async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Ensure user can only access their own client
    if (req.user.clientId !== clientId && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await db.query(`
      SELECT c.*, 
        (SELECT json_agg(p) FROM pharmacies p WHERE p.client_id = c.client_id) as pharmacies,
        (SELECT json_agg(json_build_object('userId', u.user_id, 'email', u.email, 'firstName', u.first_name, 'lastName', u.last_name, 'role', u.role)) 
         FROM users u WHERE u.client_id = c.client_id) as users
      FROM clients c
      WHERE c.client_id = $1
    `, [clientId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Get client error', { error: error.message });
    res.status(500).json({ error: 'Failed to get client' });
  }
});

// Create new client (onboarding)
router.post('/', async (req, res) => {
  try {
    const {
      clientName,
      pharmacyNpi,
      submitterEmail,
      primaryContactName,
      primaryContactPhone,
      pharmacyName,
      pharmacyState,
      pmsSystem
    } = req.body;

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

    // Create client
    const client = await db.insert('clients', {
      client_id: uuidv4(),
      client_name: clientName,
      pharmacy_npi: pharmacyNpi,
      submitter_email: submitterEmail.toLowerCase(),
      dashboard_subdomain: finalSubdomain,
      primary_contact_name: primaryContactName,
      primary_contact_phone: primaryContactPhone,
      status: 'onboarding',
      subscription_tier: 'starter'
    });

    // Create pharmacy
    const pharmacy = await db.insert('pharmacies', {
      pharmacy_id: uuidv4(),
      client_id: client.client_id,
      pharmacy_npi: pharmacyNpi,
      pharmacy_name: pharmacyName || clientName,
      state: pharmacyState,
      pms_system: pmsSystem
    });

    // Create initial admin user with temp password
    const tempPassword = uuidv4().slice(0, 12);
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await db.insert('users', {
      user_id: uuidv4(),
      client_id: client.client_id,
      pharmacy_id: pharmacy.pharmacy_id,
      email: submitterEmail.toLowerCase(),
      password_hash: passwordHash,
      first_name: primaryContactName?.split(' ')[0] || 'Admin',
      last_name: primaryContactName?.split(' ').slice(1).join(' ') || '',
      role: 'owner',
      must_change_password: true
    });

    logger.info('New client created', { 
      clientId: client.client_id, 
      subdomain: finalSubdomain 
    });

    res.status(201).json({
      success: true,
      client: {
        clientId: client.client_id,
        clientName: client.client_name,
        subdomain: finalSubdomain,
        dashboardUrl: `https://${finalSubdomain}.therxos.app`
      },
      pharmacy: {
        pharmacyId: pharmacy.pharmacy_id,
        pharmacyName: pharmacy.pharmacy_name
      },
      credentials: {
        email: submitterEmail.toLowerCase(),
        temporaryPassword: tempPassword,
        mustChangePassword: true
      }
    });
  } catch (error) {
    logger.error('Create client error', { error: error.message });
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// Update client
router.patch('/:clientId', authenticateToken, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const { clientId } = req.params;
    
    // Ensure user can only update their own client
    if (req.user.clientId !== clientId && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const allowedFields = ['client_name', 'primary_contact_name', 'primary_contact_phone', 'billing_email', 'settings', 'status'];
    const updates = {};
    
    for (const field of allowedFields) {
      const camelField = field.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (req.body[camelField] !== undefined) {
        updates[field] = req.body[camelField];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await db.update('clients', 'client_id', clientId, updates);
    res.json(result);
  } catch (error) {
    logger.error('Update client error', { error: error.message });
    res.status(500).json({ error: 'Failed to update client' });
  }
});

export default router;
