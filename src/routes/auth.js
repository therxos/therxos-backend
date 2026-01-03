// Authentication routes for TheRxOS V2
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Validation schemas
const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  clientId: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'pharmacist', 'technician', 'staff']).optional()
});

// Generate JWT token
function generateToken(user) {
  return jwt.sign(
    {
      userId: user.user_id,
      clientId: user.client_id,
      pharmacyId: user.pharmacy_id,
      email: user.email,
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// Auth middleware
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// Require specific roles
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);

    // Find user
    const result = await db.query(`
      SELECT u.*, c.client_name, c.dashboard_subdomain, p.pharmacy_name
      FROM users u
      JOIN clients c ON c.client_id = u.client_id
      LEFT JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id
      WHERE u.email = $1 AND u.is_active = true
    `, [email.toLowerCase()]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last login
    await db.query(
      'UPDATE users SET last_login_at = NOW() WHERE user_id = $1',
      [user.user_id]
    );

    // Generate token
    const token = generateToken(user);

    logger.info('User logged in', { userId: user.user_id, email: user.email });

    res.json({
      token,
      user: {
        userId: user.user_id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        clientId: user.client_id,
        clientName: user.client_name,
        pharmacyId: user.pharmacy_id,
        pharmacyName: user.pharmacy_name,
        subdomain: user.dashboard_subdomain,
        mustChangePassword: user.must_change_password
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    logger.error('Login error', { error: error.message });
    res.status(500).json({ error: 'Login failed' });
  }
});

// Register new user (admin only)
router.post('/register', authenticateToken, requireRole('owner', 'admin'), async (req, res) => {
  try {
    const data = registerSchema.parse(req.body);

    // Check if email already exists
    const existing = await db.query(
      'SELECT user_id FROM users WHERE email = $1',
      [data.email.toLowerCase()]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(data.password, 12);

    // Create user
    const result = await db.insert('users', {
      email: data.email.toLowerCase(),
      password_hash: passwordHash,
      first_name: data.firstName,
      last_name: data.lastName,
      client_id: data.clientId,
      role: data.role || 'staff',
      must_change_password: true
    });

    logger.info('User registered', { userId: result.user_id, email: result.email });

    res.status(201).json({
      success: true,
      user: {
        userId: result.user_id,
        email: result.email,
        firstName: result.first_name,
        lastName: result.last_name,
        role: result.role
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid input', details: error.errors });
    }
    logger.error('Registration error', { error: error.message });
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Change password
router.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    // Get current user
    const result = await db.query(
      'SELECT password_hash FROM users WHERE user_id = $1',
      [req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const validPassword = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash and update new password
    const newHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      'UPDATE users SET password_hash = $1, must_change_password = false WHERE user_id = $2',
      [newHash, req.user.userId]
    );

    logger.info('Password changed', { userId: req.user.userId });

    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    logger.error('Password change error', { error: error.message });
    res.status(500).json({ error: 'Password change failed' });
  }
});

// Get current user info
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT u.*, c.client_name, c.dashboard_subdomain, p.pharmacy_name
      FROM users u
      JOIN clients c ON c.client_id = u.client_id
      LEFT JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id
      WHERE u.user_id = $1
    `, [req.user.userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];

    res.json({
      userId: user.user_id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: user.role,
      clientId: user.client_id,
      clientName: user.client_name,
      pharmacyId: user.pharmacy_id,
      pharmacyName: user.pharmacy_name,
      subdomain: user.dashboard_subdomain,
      mustChangePassword: user.must_change_password,
      notificationPreferences: user.notification_preferences
    });
  } catch (error) {
    logger.error('Get user error', { error: error.message });
    res.status(500).json({ error: 'Failed to get user info' });
  }
});

// Logout (client-side, just for logging)
router.post('/logout', authenticateToken, (req, res) => {
  logger.info('User logged out', { userId: req.user.userId });
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
