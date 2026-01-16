// TheRxOS V2 Backend API Server
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import cron from 'node-cron';

import { logger, requestLogger } from './utils/logger.js';
import db from './database/index.js';
import { ingestCSV, resolveClientFromEmail } from './services/ingestion.js';
import { runOpportunityScan, updatePatientProfiles } from './services/scanner.js';
import { verifyOpportunityCoverage } from './services/medicare.js';
import authRoutes from './routes/auth.js';
import clientRoutes from './routes/clients.js';
import opportunityRoutes from './routes/opportunities.js';
import patientRoutes from './routes/patients.js';
import analyticsRoutes from './routes/analytics.js';
import prospectsRoutes from './routes/prospects.js';
import adminRoutes from './routes/admin.js';
import automationRoutes from './routes/automation.js';
import settingsRoutes from './routes/settings.js';
import feedbackRoutes from './routes/feedback.js';
import pricingRoutes from './routes/pricing.js';
import secureUploadRoutes from './routes/secure-upload.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) ||
      ['http://localhost:3000', 'https://therxos.com', 'https://www.therxos.com', 'https://beta.therxos.com'];

    // Check if origin matches allowed list (also handle www/non-www variants)
    const isAllowed = allowedOrigins.some(allowed => {
      if (origin === allowed) return true;
      // Auto-allow www variant if non-www is allowed and vice versa
      if (allowed.includes('therxos.com')) {
        const withWww = allowed.replace('https://', 'https://www.');
        const withoutWww = allowed.replace('https://www.', 'https://');
        if (origin === withWww || origin === withoutWww) return true;
      }
      return false;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(requestLogger);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  }
});

// Health check
app.get('/health', async (req, res) => {
  const dbHealth = await db.healthCheck();
  const dbHost = process.env.DATABASE_URL?.split('@')[1]?.split(':')[0] || 'unknown';
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    database: dbHealth,
    dbHost: dbHost
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/opportunities', opportunityRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/prospects', prospectsRoutes);
app.use('/api/checkout', prospectsRoutes); // Checkout routes are in prospects.js
app.use('/api/admin', adminRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/pricing', pricingRoutes);
app.use('/api/secure-upload', secureUploadRoutes);

// CSV Upload endpoint
app.post('/api/ingest/csv', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { pharmacyId, clientId, sourceEmail, runAutoComplete, runScan } = req.body;

    // Try to get pharmacyId from JWT token if not in form data
    let tokenPharmacyId = null;
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const jwt = await import('jsonwebtoken');
        const decoded = jwt.default.verify(token, process.env.JWT_SECRET);
        tokenPharmacyId = decoded.pharmacyId;
      } catch (e) {
        // Token invalid, continue without it
      }
    }

    // If no pharmacy specified, try to resolve from email
    let resolvedPharmacy = null;
    if (!pharmacyId && !tokenPharmacyId && sourceEmail) {
      resolvedPharmacy = await resolveClientFromEmail(sourceEmail);
      if (!resolvedPharmacy) {
        return res.status(404).json({ error: 'Could not identify pharmacy from email' });
      }
    }

    const finalPharmacyId = pharmacyId || tokenPharmacyId || resolvedPharmacy?.pharmacy_id;

    if (!finalPharmacyId) {
      return res.status(400).json({ error: 'Pharmacy ID is required' });
    }

    const result = await ingestCSV(req.file.buffer, {
      pharmacyId: finalPharmacyId,
      clientId: clientId || resolvedPharmacy?.client_id,
      sourceEmail,
      sourceFile: req.file.originalname
      // pmsSystem auto-detected from CSV headers
    });

    let autoCompleteResult = null;
    let scanResult = null;

    // Optionally run auto-complete after ingestion
    if (runAutoComplete === 'true' && finalPharmacyId) {
      try {
        const { autoCompleteOpportunities } = await import('./services/gmailPoller.js');
        const recentRx = await db.query(`
          SELECT p.*, pat.first_name as patient_first, pat.last_name as patient_last
          FROM prescriptions p
          LEFT JOIN patients pat ON pat.patient_id = p.patient_id
          WHERE p.pharmacy_id = $1
          AND p.source_file = $2
          AND p.created_at >= NOW() - INTERVAL '1 hour'
        `, [finalPharmacyId, req.file.originalname]);
        autoCompleteResult = await autoCompleteOpportunities(finalPharmacyId, recentRx.rows);
      } catch (err) {
        logger.error('Auto-complete after upload failed', { error: err.message });
      }
    }

    // Optionally run opportunity scan after ingestion
    if (runScan === 'true' && finalPharmacyId) {
      try {
        scanResult = await runOpportunityScan({
          pharmacyIds: [finalPharmacyId],
          scanType: 'manual_upload',
          lookbackHours: 1
        });
      } catch (err) {
        logger.error('Scan after upload failed', { error: err.message });
      }
    }

    res.json({
      success: true,
      message: 'CSV ingested successfully',
      ...result,
      // Add fields frontend expects
      recordsProcessed: result.stats?.inserted || 0,
      prescriptionsCreated: result.stats?.inserted || 0,
      patientsCreated: result.stats?.uniquePatients || 0,
      autoComplete: autoCompleteResult,
      scan: scanResult
    });
  } catch (error) {
    logger.error('CSV ingestion error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Manual scan trigger
app.post('/api/scan/trigger', async (req, res) => {
  try {
    const { pharmacyIds, scanType = 'manual' } = req.body;
    
    const result = await runOpportunityScan({
      pharmacyIds,
      scanType,
      lookbackHours: 24
    });

    res.json({
      success: true,
      message: 'Scan completed',
      ...result
    });
  } catch (error) {
    logger.error('Manual scan error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get opportunities for a pharmacy
app.get('/api/pharmacy/:pharmacyId/opportunities', async (req, res) => {
  try {
    const { pharmacyId } = req.params;
    const { status, type, limit = 50, offset = 0 } = req.query;

    let query = `
      SELECT o.*, p.patient_hash, p.chronic_conditions
      FROM opportunities o
      LEFT JOIN patients p ON p.patient_id = o.patient_id
      WHERE o.pharmacy_id = $1
    `;
    const params = [pharmacyId];
    let paramIndex = 2;

    if (status) {
      query += ` AND o.status = $${paramIndex++}`;
      params.push(status);
    }
    if (type) {
      query += ` AND o.opportunity_type = $${paramIndex++}`;
      params.push(type);
    }

    query += ` ORDER BY o.potential_margin_gain DESC, o.created_at DESC`;
    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);
    
    // Get total count
    const countResult = await db.query(`
      SELECT COUNT(*) as total FROM opportunities WHERE pharmacy_id = $1
      ${status ? 'AND status = $2' : ''}
      ${type ? `AND opportunity_type = $${status ? 3 : 2}` : ''}
    `, status || type ? [pharmacyId, status, type].filter(Boolean) : [pharmacyId]);

    res.json({
      opportunities: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (error) {
    logger.error('Fetch opportunities error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Update opportunity status
app.patch('/api/opportunities/:opportunityId', async (req, res) => {
  try {
    const { opportunityId } = req.params;
    const { status, staffNotes, actualMarginRealized, dismissedReason } = req.body;

    const updates = {};
    if (status) updates.status = status;
    if (staffNotes !== undefined) updates.staff_notes = staffNotes;
    if (actualMarginRealized !== undefined) updates.actual_margin_realized = actualMarginRealized;
    if (dismissedReason) updates.dismissed_reason = dismissedReason;

    if (status === 'reviewed') {
      updates.reviewed_at = new Date();
    } else if (status === 'actioned') {
      updates.actioned_at = new Date();
    }

    const result = await db.update('opportunities', 'opportunity_id', opportunityId, updates);
    
    res.json({
      success: true,
      opportunity: result
    });
  } catch (error) {
    logger.error('Update opportunity error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get patient profile
app.get('/api/patients/:patientId', async (req, res) => {
  try {
    const { patientId } = req.params;

    const patient = await db.query(`
      SELECT p.*, 
        (SELECT json_agg(rx ORDER BY rx.dispensed_date DESC)
         FROM (SELECT * FROM prescriptions WHERE patient_id = p.patient_id LIMIT 50) rx
        ) as medications,
        (SELECT json_agg(opp ORDER BY opp.created_at DESC)
         FROM (SELECT * FROM opportunities WHERE patient_id = p.patient_id AND status IN ('new', 'reviewed') LIMIT 20) opp
        ) as opportunities
      FROM patients p
      WHERE p.patient_id = $1
    `, [patientId]);

    if (patient.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    res.json(patient.rows[0]);
  } catch (error) {
    logger.error('Fetch patient error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Dashboard stats
app.get('/api/pharmacy/:pharmacyId/stats', async (req, res) => {
  try {
    const { pharmacyId } = req.params;

    const stats = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Not Submitted') as new_opportunities,
        (SELECT COUNT(*) FROM opportunities WHERE pharmacy_id = $1 AND status IN ('Completed', 'Approved') AND updated_at >= NOW() - INTERVAL '30 days') as actioned_this_month,
        (SELECT COALESCE(SUM(potential_margin_gain), 0) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Not Submitted') as potential_margin,
        (SELECT COALESCE(SUM(annual_margin_gain), 0) FROM opportunities WHERE pharmacy_id = $1 AND status IN ('Completed', 'Approved')) as captured_value,
        (SELECT COUNT(*) FROM prescriptions WHERE pharmacy_id = $1 AND dispensed_date >= NOW() - INTERVAL '30 days') as prescriptions_this_month,
        (SELECT COUNT(*) FROM patients WHERE pharmacy_id = $1) as total_patients,
        (SELECT COUNT(DISTINCT patient_id) FROM opportunities WHERE pharmacy_id = $1 AND status = 'Not Submitted') as patients_with_opportunities,
        (SELECT COUNT(DISTINCT patient_id) FROM prescriptions WHERE pharmacy_id = $1 AND dispensed_date >= NOW() - INTERVAL '30 days') as active_patients
    `, [pharmacyId]);

    const byType = await db.query(`
      SELECT opportunity_type, COUNT(*) as count, SUM(potential_margin_gain) as margin
      FROM opportunities
      WHERE pharmacy_id = $1 AND status = 'Not Submitted'
      GROUP BY opportunity_type
    `, [pharmacyId]);

    res.json({
      ...stats.rows[0],
      byType: byType.rows
    });
  } catch (error) {
    logger.error('Fetch stats error', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Schedule nightly Gmail poll (6 AM daily - before scan)
cron.schedule('0 6 * * *', async () => {
  logger.info('Starting scheduled Gmail poll');
  try {
    // Get all active pharmacies
    const pharmacies = await db.query(`
      SELECT p.pharmacy_id FROM pharmacies p
      JOIN clients c ON c.client_id = p.client_id
      WHERE c.status = 'active'
      AND p.pharmacy_name NOT ILIKE '%hero%'
      AND p.pharmacy_name NOT ILIKE '%demo%'
    `);

    const { pollForSPPReports } = await import('./services/gmailPoller.js');

    for (const pharmacy of pharmacies.rows) {
      try {
        logger.info('Polling SPP reports for pharmacy', { pharmacyId: pharmacy.pharmacy_id });
        await pollForSPPReports({ pharmacyId: pharmacy.pharmacy_id, daysBack: 1 });
      } catch (err) {
        logger.error('Gmail poll failed for pharmacy', { pharmacyId: pharmacy.pharmacy_id, error: err.message });
      }
    }
    logger.info('Scheduled Gmail poll completed');
  } catch (error) {
    logger.error('Scheduled Gmail poll failed', { error: error.message });
  }
}, {
  timezone: 'America/New_York'
});

// Schedule nightly scans (7 AM daily - after Gmail poll)
cron.schedule('0 7 * * *', async () => {
  logger.info('Starting scheduled nightly scan');
  try {
    // Run regular opportunity scan
    const scanResult = await runOpportunityScan({ scanType: 'nightly_batch', lookbackHours: 24 });
    logger.info('Nightly scan completed', { opportunities: scanResult.opportunitiesFound });

    // Run Medicare coverage verification for opportunities with Part D plans
    logger.info('Starting Medicare coverage verification');
    const medicareResult = await verifyOpportunityCoverage();
    logger.info('Medicare verification completed', {
      verified: medicareResult.verified,
      covered: medicareResult.covered,
      notCovered: medicareResult.notCovered
    });

  } catch (error) {
    logger.error('Nightly scan failed', { error: error.message });
  }
}, {
  timezone: 'America/New_York'
});

// Schedule daily cleanup of expired secure uploads (3 AM daily)
cron.schedule('0 3 * * *', async () => {
  logger.info('Starting scheduled secure upload cleanup');
  try {
    const secureUpload = await import('./services/secure-upload.js');
    const cleanedCount = await secureUpload.cleanupExpiredUploads();
    logger.info('Secure upload cleanup completed', { cleanedCount });
  } catch (error) {
    logger.error('Secure upload cleanup failed', { error: error.message });
  }
}, {
  timezone: 'America/New_York'
});

// Start server
app.listen(PORT, () => {
  logger.info(`TheRxOS V2 API server running on port ${PORT}`);
});

export default app;
