/**
 * Secure Upload Routes for TheRxOS V2
 * HIPAA-compliant file upload for prospects
 */

import express from 'express';
import multer from 'multer';
import { authenticateToken } from './auth.js';
import { ROLES } from '../utils/permissions.js';
import secureUpload from '../services/secure-upload.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Configure multer for memory storage (files encrypted before disk storage)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || '100') * 1024 * 1024,
    files: 10
  },
  fileFilter: (req, file, cb) => {
    // Allow common data file types
    const allowedTypes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/pdf',
      'text/plain',
      'application/zip',
      'application/gzip'
    ];

    const allowedExtensions = ['.csv', '.xlsx', '.xls', '.pdf', '.txt', '.zip', '.gz'];
    const ext = file.originalname.toLowerCase().slice(file.originalname.lastIndexOf('.'));

    if (allowedTypes.includes(file.mimetype) || allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Allowed: CSV, Excel, PDF, TXT, ZIP'));
    }
  }
});

// Middleware to check super admin
function requireSuperAdmin(req, res, next) {
  if (req.user?.role !== ROLES.SUPER_ADMIN) {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// Helper to get client IP
function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.headers['x-real-ip'] ||
         req.connection?.remoteAddress ||
         req.ip;
}

// ===========================================
// ADMIN ENDPOINTS (authenticated)
// ===========================================

// POST /api/secure-upload/admin/create - Create new upload link
router.post('/admin/create', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { pharmacyName, contactEmail, contactPhone, notes, expiryDays } = req.body;

    if (!pharmacyName || !contactEmail) {
      return res.status(400).json({ error: 'pharmacyName and contactEmail are required' });
    }

    const result = await secureUpload.createUploadLink({
      pharmacyName,
      contactEmail,
      contactPhone,
      notes,
      createdBy: req.user.userId,
      expiryDays: parseInt(expiryDays) || 30
    });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    logger.error('Create upload link error', { error: error.message });
    res.status(500).json({ error: 'Failed to create upload link' });
  }
});

// GET /api/secure-upload/admin/list - List all uploads
router.get('/admin/list', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { status, limit, offset } = req.query;

    const uploads = await secureUpload.listUploads({
      status,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0
    });

    res.json({ uploads });
  } catch (error) {
    logger.error('List uploads error', { error: error.message });
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

// GET /api/secure-upload/admin/:uploadId - Get upload details
router.get('/admin/:uploadId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { uploadId } = req.params;

    const upload = await secureUpload.getUploadById(uploadId);
    if (!upload) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    const files = await secureUpload.getUploadFiles(uploadId);
    const auditLog = await secureUpload.getAuditLog(uploadId);

    res.json({
      upload,
      files,
      auditLog
    });
  } catch (error) {
    logger.error('Get upload details error', { error: error.message });
    res.status(500).json({ error: 'Failed to get upload details' });
  }
});

// POST /api/secure-upload/admin/:uploadId/extend - Extend expiration
router.post('/admin/:uploadId/extend', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { uploadId } = req.params;
    const { additionalDays } = req.body;

    if (!additionalDays || additionalDays < 1) {
      return res.status(400).json({ error: 'additionalDays must be at least 1' });
    }

    const newExpiresAt = await secureUpload.extendExpiration(
      uploadId,
      parseInt(additionalDays),
      req.user.userId
    );

    if (!newExpiresAt) {
      return res.status(404).json({ error: 'Upload not found' });
    }

    res.json({ success: true, expiresAt: newExpiresAt });
  } catch (error) {
    logger.error('Extend expiration error', { error: error.message });
    res.status(500).json({ error: 'Failed to extend expiration' });
  }
});

// DELETE /api/secure-upload/admin/:uploadId - Delete upload
router.delete('/admin/:uploadId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { uploadId } = req.params;

    await secureUpload.deleteUpload(uploadId, req.user.userId);

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete upload error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete upload' });
  }
});

// GET /api/secure-upload/admin/:uploadId/download/:fileId - Download file
router.get('/admin/:uploadId/download/:fileId', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const { uploadId, fileId } = req.params;
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'];

    const file = await secureUpload.downloadFile(
      uploadId,
      fileId,
      req.user.userId,
      ip,
      userAgent
    );

    if (!file) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.send(file.buffer);
  } catch (error) {
    logger.error('Download file error', { error: error.message });
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// POST /api/secure-upload/admin/cleanup - Run cleanup of expired uploads
router.post('/admin/cleanup', authenticateToken, requireSuperAdmin, async (req, res) => {
  try {
    const cleanedCount = await secureUpload.cleanupExpiredUploads();
    res.json({ success: true, cleanedCount });
  } catch (error) {
    logger.error('Cleanup error', { error: error.message });
    res.status(500).json({ error: 'Failed to cleanup expired uploads' });
  }
});

// ===========================================
// PROSPECT ENDPOINTS (token-based auth)
// ===========================================

// GET /api/secure-upload/portal/:token - Get upload portal info
router.get('/portal/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'];

    const upload = await secureUpload.getUploadByToken(token);

    if (!upload) {
      return res.status(404).json({ error: 'Upload link not found or expired' });
    }

    if (upload.status === 'expired' || new Date(upload.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This upload link has expired' });
    }

    if (upload.status === 'deleted') {
      return res.status(410).json({ error: 'This upload link is no longer available' });
    }

    // Log access
    await secureUpload.logAccess(upload.upload_id, ip, userAgent);

    // Get files if BAA accepted
    let files = [];
    if (upload.baa_accepted) {
      files = await secureUpload.getUploadFiles(upload.upload_id);
    }

    res.json({
      pharmacyName: upload.pharmacy_name,
      contactEmail: upload.contact_email,
      baaAccepted: upload.baa_accepted,
      baaContent: upload.baa_content,
      baaVersion: upload.baa_version,
      expiresAt: upload.expires_at,
      status: upload.status,
      files: files.map(f => ({
        fileId: f.file_id,
        filename: f.original_filename,
        size: f.file_size_bytes,
        type: f.file_type,
        uploadedAt: f.uploaded_at
      }))
    });
  } catch (error) {
    logger.error('Get portal error', { error: error.message });
    res.status(500).json({ error: 'Failed to load upload portal' });
  }
});

// POST /api/secure-upload/portal/:token/accept-baa - Accept BAA
router.post('/portal/:token/accept-baa', async (req, res) => {
  try {
    const { token } = req.params;
    const { signerName } = req.body;
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'];

    if (!signerName || signerName.trim().length < 2) {
      return res.status(400).json({ error: 'Signer name is required' });
    }

    const upload = await secureUpload.getUploadByToken(token);

    if (!upload) {
      return res.status(404).json({ error: 'Upload link not found' });
    }

    if (upload.status === 'expired' || new Date(upload.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This upload link has expired' });
    }

    const success = await secureUpload.acceptBAA(
      upload.upload_id,
      signerName.trim(),
      ip,
      userAgent
    );

    if (!success) {
      return res.status(400).json({ error: 'BAA already accepted or upload not found' });
    }

    res.json({ success: true, message: 'BAA accepted. You may now upload files.' });
  } catch (error) {
    logger.error('Accept BAA error', { error: error.message });
    res.status(500).json({ error: 'Failed to accept BAA' });
  }
});

// POST /api/secure-upload/portal/:token/files - Upload files
router.post('/portal/:token/files', upload.array('files', 10), async (req, res) => {
  try {
    const { token } = req.params;
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'];

    const uploadRecord = await secureUpload.getUploadByToken(token);

    if (!uploadRecord) {
      return res.status(404).json({ error: 'Upload link not found' });
    }

    if (!uploadRecord.baa_accepted) {
      return res.status(403).json({ error: 'BAA must be accepted before uploading files' });
    }

    if (uploadRecord.status === 'expired' || new Date(uploadRecord.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This upload link has expired' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const uploadedFiles = [];

    for (const file of req.files) {
      try {
        const result = await secureUpload.uploadFile(
          uploadRecord.upload_id,
          file,
          ip,
          userAgent
        );
        uploadedFiles.push(result);
      } catch (error) {
        logger.error('File upload error', { filename: file.originalname, error: error.message });
        uploadedFiles.push({
          originalFilename: file.originalname,
          error: error.message
        });
      }
    }

    const successCount = uploadedFiles.filter(f => !f.error).length;
    const errorCount = uploadedFiles.filter(f => f.error).length;

    res.json({
      success: successCount > 0,
      message: `${successCount} file(s) uploaded successfully${errorCount > 0 ? `, ${errorCount} failed` : ''}`,
      files: uploadedFiles
    });
  } catch (error) {
    logger.error('Upload files error', { error: error.message });
    res.status(500).json({ error: 'Failed to upload files' });
  }
});

// DELETE /api/secure-upload/portal/:token/files/:fileId - Delete a file
router.delete('/portal/:token/files/:fileId', async (req, res) => {
  try {
    const { token, fileId } = req.params;
    const ip = getClientIP(req);
    const userAgent = req.headers['user-agent'];

    const upload = await secureUpload.getUploadByToken(token);

    if (!upload) {
      return res.status(404).json({ error: 'Upload link not found' });
    }

    if (upload.status === 'expired' || new Date(upload.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This upload link has expired' });
    }

    const success = await secureUpload.deleteFile(
      upload.upload_id,
      fileId,
      'prospect',
      null,
      ip,
      userAgent
    );

    if (!success) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('Delete file error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// GET /api/secure-upload/portal/:token/status - Get upload status
router.get('/portal/:token/status', async (req, res) => {
  try {
    const { token } = req.params;

    const upload = await secureUpload.getUploadByToken(token);

    if (!upload) {
      return res.status(404).json({ error: 'Upload link not found' });
    }

    const files = upload.baa_accepted
      ? await secureUpload.getUploadFiles(upload.upload_id)
      : [];

    res.json({
      status: upload.status,
      baaAccepted: upload.baa_accepted,
      fileCount: files.length,
      totalSize: files.reduce((sum, f) => sum + f.file_size_bytes, 0),
      expiresAt: upload.expires_at
    });
  } catch (error) {
    logger.error('Get status error', { error: error.message });
    res.status(500).json({ error: 'Failed to get status' });
  }
});

export default router;
