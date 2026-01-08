// Feedback/Suggestions API for TheRxOS
// Handles user feedback submissions and sends to stan@therxos.com

import express from 'express';
import nodemailer from 'nodemailer';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// JWT authentication middleware (imported inline to avoid circular deps)
import jwt from 'jsonwebtoken';

const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Create email transporter
// Uses SMTP - configure with SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS env vars
// Or falls back to Gmail SMTP if GMAIL_USER and GMAIL_APP_PASSWORD are set
function createTransporter() {
  // Option 1: Custom SMTP
  if (process.env.SMTP_HOST) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Option 2: Gmail SMTP with app password
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
  }

  // No email configured - will log instead
  return null;
}

/**
 * POST /api/feedback
 * Submit feedback or suggestion
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { type, message, triggerDrug, recommendedDrug, insurances } = req.body;
    const userId = req.user.userId;

    if (!message || message.trim() === '') {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get user info for the email
    const userResult = await db.query(`
      SELECT u.email, u.first_name, u.last_name, p.pharmacy_name, c.client_name
      FROM users u
      LEFT JOIN pharmacies p ON p.pharmacy_id = u.pharmacy_id
      LEFT JOIN clients c ON c.client_id = u.client_id
      WHERE u.user_id = $1
    `, [userId]);

    const user = userResult.rows[0] || {};
    const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unknown User';
    const userEmail = user.email || 'unknown@email.com';
    const pharmacyName = user.pharmacy_name || user.client_name || 'Unknown Pharmacy';

    // Store in database for record-keeping
    try {
      await db.query(`
        INSERT INTO feedback_submissions (
          user_id, feedback_type, message, trigger_drug, recommended_drug, insurances, submitted_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [userId, type, message, triggerDrug || null, recommendedDrug || null, insurances || null]);
    } catch (dbError) {
      // Table might not exist yet, that's OK - email is the priority
      logger.warn('Could not store feedback in database (table may not exist)', { error: dbError.message });
    }

    // Build email content
    const typeLabels = {
      feedback: 'General Feedback',
      idea: 'Feature Idea',
      opportunity: 'New Opportunity Request',
      bug: 'Bug Report',
    };

    let emailBody = `
New ${typeLabels[type] || 'Feedback'} Submission

From: ${userName}
Email: ${userEmail}
Pharmacy: ${pharmacyName}
Type: ${typeLabels[type] || type}
Submitted: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST

---

Message:
${message}
`;

    // Add opportunity-specific details if applicable
    if (type === 'opportunity') {
      emailBody += `
---

Opportunity Details:
Trigger Drug: ${triggerDrug || 'Not specified'}
Recommended Drug: ${recommendedDrug || 'Not specified'}
Insurances: ${insurances || 'Not specified'}
`;
    }

    // Send email
    const transporter = createTransporter();

    if (transporter) {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.GMAIL_USER || 'noreply@therxos.com',
          to: 'stan@therxos.com',
          replyTo: userEmail,
          subject: `[TheRxOS Feedback] ${typeLabels[type] || 'Feedback'} from ${pharmacyName}`,
          text: emailBody,
        });

        logger.info('Feedback email sent', { userId, type, pharmacyName });
      } catch (emailError) {
        // Log the email content so it's not lost
        logger.error('Failed to send feedback email', {
          error: emailError.message,
          fallbackContent: emailBody
        });
        // Don't fail the request - the feedback is logged
      }
    } else {
      // No email configured - log the feedback
      logger.info('Feedback received (email not configured)', {
        userId,
        type,
        pharmacyName,
        content: emailBody
      });
    }

    res.json({
      success: true,
      message: 'Feedback submitted successfully'
    });

  } catch (error) {
    logger.error('Feedback submission error', { error: error.message });
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

export default router;
