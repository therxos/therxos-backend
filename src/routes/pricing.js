// Pricing and Medicare Routes for TheRxOS V2
// Handles 832 file uploads, Medicare coverage verification, and pricing data

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import { authenticateToken } from './auth.js';
import { parse832File, load832Data, parseCSVPricingFile } from '../services/edi832Parser.js';
import { verifyOpportunityCoverage, checkMedicareCoverage, getCMSReimbursementRate } from '../services/medicare.js';

const router = express.Router();

// Configure multer for 832 file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = './uploads/pricing';
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${uuidv4().slice(0, 8)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.832', '.edi', '.txt', '.csv'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${allowedTypes.join(', ')}`));
    }
  },
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB max
  }
});

/**
 * Upload and process 832/pricing file
 * POST /api/pricing/upload
 */
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  const logId = uuidv4();

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { source = 'manual' } = req.body;
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const ext = path.extname(fileName).toLowerCase();

    logger.info('Processing pricing file', { logId, fileName, source });

    // Log the upload
    await db.insert('pricing_file_logs', {
      log_id: logId,
      file_name: fileName,
      file_type: ext === '.csv' ? 'csv' : '832',
      source,
      status: 'processing'
    });

    // Parse based on file type
    let parsed;
    if (ext === '.csv') {
      parsed = await parseCSVPricingFile(filePath, source, {
        contractId: req.body.contractId
      });
    } else {
      parsed = await parse832File(filePath, source);
    }

    // Load into database
    const result = await load832Data(parsed);

    // Update log
    await db.query(`
      UPDATE pricing_file_logs SET
        records_processed = $1,
        records_inserted = $2,
        records_updated = $3,
        errors = $4,
        batch_id = $5,
        status = 'completed',
        completed_at = NOW()
      WHERE log_id = $6
    `, [
      parsed.records.length,
      result.inserted,
      result.updated,
      result.errors,
      result.batchId,
      logId
    ]);

    // Clean up uploaded file
    await fs.unlink(filePath).catch(() => {});

    res.json({
      success: true,
      logId,
      batchId: result.batchId,
      stats: {
        recordsProcessed: parsed.records.length,
        inserted: result.inserted,
        updated: result.updated,
        errors: result.errors,
        ...parsed.stats
      }
    });

  } catch (error) {
    logger.error('Pricing file processing failed', { logId, error: error.message });

    await db.query(`
      UPDATE pricing_file_logs SET
        status = 'failed',
        error_message = $1,
        completed_at = NOW()
      WHERE log_id = $2
    `, [error.message, logId]);

    // Clean up file on error
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch(() => {});
    }

    res.status(500).json({ error: error.message });
  }
});

/**
 * Trigger Medicare coverage verification for all pending opportunities
 * POST /api/pricing/verify-medicare
 */
router.post('/verify-medicare', authenticateToken, async (req, res) => {
  try {
    const { pharmacyId } = req.body;

    logger.info('Manual Medicare verification triggered', {
      userId: req.user.userId,
      pharmacyId
    });

    // Run verification (may take a while for large datasets)
    const result = await verifyOpportunityCoverage(pharmacyId || req.user.pharmacyId);

    res.json({
      success: true,
      ...result
    });

  } catch (error) {
    logger.error('Medicare verification failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Check Medicare coverage for a specific drug
 * GET /api/pricing/coverage/:contractId/:ndc
 */
router.get('/coverage/:contractId/:ndc', authenticateToken, async (req, res) => {
  try {
    const { contractId, ndc } = req.params;
    const { planId } = req.query;

    const coverage = await checkMedicareCoverage(contractId, planId, ndc);

    res.json(coverage);

  } catch (error) {
    logger.error('Coverage check failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get reimbursement rate for a drug
 * GET /api/pricing/rate/:ndc
 */
router.get('/rate/:ndc', authenticateToken, async (req, res) => {
  try {
    const { ndc } = req.params;
    const { contractId } = req.query;

    const rate = await getCMSReimbursementRate(ndc, contractId);

    if (!rate) {
      return res.status(404).json({ error: 'No pricing data found' });
    }

    res.json(rate);

  } catch (error) {
    logger.error('Rate lookup failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get pricing file upload history
 * GET /api/pricing/logs
 */
router.get('/logs', authenticateToken, async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    const result = await db.query(`
      SELECT * FROM pricing_file_logs
      ORDER BY started_at DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({ logs: result.rows });

  } catch (error) {
    logger.error('Failed to get pricing logs', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get drug pricing data
 * GET /api/pricing/drugs
 */
router.get('/drugs', authenticateToken, async (req, res) => {
  try {
    const { ndc, contractId, source, limit = 100 } = req.query;

    let query = 'SELECT * FROM drug_pricing WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (ndc) {
      query += ` AND ndc = $${paramIndex++}`;
      params.push(ndc.replace(/-/g, ''));
    }
    if (contractId) {
      query += ` AND contract_id = $${paramIndex++}`;
      params.push(contractId);
    }
    if (source) {
      query += ` AND source = $${paramIndex++}`;
      params.push(source);
    }

    query += ` ORDER BY effective_date DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json({ pricing: result.rows });

  } catch (error) {
    logger.error('Failed to get drug pricing', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Medicare formulary data
 * GET /api/pricing/formulary
 */
router.get('/formulary', authenticateToken, async (req, res) => {
  try {
    const { contractId, ndc, tier, limit = 100 } = req.query;

    let query = 'SELECT * FROM medicare_formulary WHERE 1=1';
    const params = [];
    let paramIndex = 1;

    if (contractId) {
      query += ` AND contract_id = $${paramIndex++}`;
      params.push(contractId);
    }
    if (ndc) {
      query += ` AND ndc = $${paramIndex++}`;
      params.push(ndc.replace(/-/g, ''));
    }
    if (tier) {
      query += ` AND tier = $${paramIndex++}`;
      params.push(parseInt(tier));
    }

    query += ` ORDER BY contract_id, tier LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json({ formulary: result.rows });

  } catch (error) {
    logger.error('Failed to get formulary', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get Medicare coverage stats for opportunities
 * GET /api/pricing/stats
 */
router.get('/stats', authenticateToken, async (req, res) => {
  try {
    const pharmacyId = req.user.pharmacyId;

    const result = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE medicare_verified_at IS NOT NULL) as verified_count,
        COUNT(*) FILTER (WHERE medicare_covered = true) as covered_count,
        COUNT(*) FILTER (WHERE medicare_covered = false) as not_covered_count,
        COUNT(*) FILTER (WHERE medicare_tier IS NOT NULL) as with_tier_count,
        AVG(medicare_reimbursement_rate) FILTER (WHERE medicare_reimbursement_rate IS NOT NULL) as avg_reimbursement,
        SUM(potential_margin_gain) FILTER (WHERE margin_source = 'medicare_verified') as verified_margin_total
      FROM opportunities
      WHERE pharmacy_id = $1
      AND status = 'Not Submitted'
    `, [pharmacyId]);

    const tierBreakdown = await db.query(`
      SELECT medicare_tier, COUNT(*) as count
      FROM opportunities
      WHERE pharmacy_id = $1
      AND medicare_tier IS NOT NULL
      AND status = 'Not Submitted'
      GROUP BY medicare_tier
      ORDER BY medicare_tier
    `, [pharmacyId]);

    res.json({
      ...result.rows[0],
      tierBreakdown: tierBreakdown.rows
    });

  } catch (error) {
    logger.error('Failed to get pricing stats', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

export default router;
