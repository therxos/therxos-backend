/**
 * Secure Upload Service for TheRxOS V2
 * Manages HIPAA-compliant file uploads for prospects
 */

import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import db from '../database/index.js';
import { logger } from '../utils/logger.js';
import encryption from './encryption.js';

// Configuration
const UPLOAD_DIR = process.env.UPLOAD_STORAGE_PATH || './uploads/secure';
const MAX_FILE_SIZE = parseInt(process.env.UPLOAD_MAX_FILE_SIZE_MB || '100') * 1024 * 1024;
const DEFAULT_EXPIRY_DAYS = parseInt(process.env.UPLOAD_DEFAULT_EXPIRY_DAYS || '30');

// Ensure upload directory exists
async function ensureUploadDir() {
  try {
    await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
  } catch (error) {
    logger.error('Failed to create upload directory', { error: error.message });
  }
}

// Initialize on module load
ensureUploadDir();

/**
 * Create a new secure upload link
 */
export async function createUploadLink(options) {
  const {
    pharmacyName,
    contactEmail,
    contactPhone = null,
    notes = null,
    createdBy,
    expiryDays = DEFAULT_EXPIRY_DAYS
  } = options;

  const uploadId = uuidv4();
  const accessToken = encryption.generateSecureToken(64);
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  await db.query(`
    INSERT INTO secure_uploads (
      upload_id, access_token, pharmacy_name, contact_email, contact_phone,
      notes, created_by, expires_at, auto_delete_days
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  `, [uploadId, accessToken, pharmacyName, contactEmail, contactPhone, notes, createdBy, expiresAt, expiryDays]);

  // Log creation
  await logAuditEvent(uploadId, 'created', 'admin', createdBy, null, null, {
    pharmacy_name: pharmacyName,
    contact_email: contactEmail,
    expires_days: expiryDays
  });

  logger.info('Created secure upload link', { uploadId, pharmacyName, expiresAt });

  return {
    uploadId,
    accessToken,
    expiresAt,
    uploadUrl: `${process.env.WEBSITE_URL || 'https://beta.therxos.com'}/upload/${accessToken}`
  };
}

/**
 * Get upload by access token
 */
export async function getUploadByToken(token) {
  const result = await db.query(`
    SELECT
      su.*,
      bt.content as baa_content,
      bt.version as baa_version
    FROM secure_uploads su
    LEFT JOIN baa_templates bt ON bt.is_active = true
    WHERE su.access_token = $1
  `, [token]);

  if (result.rows.length === 0) {
    return null;
  }

  const upload = result.rows[0];

  // Check if expired
  if (new Date(upload.expires_at) < new Date()) {
    upload.status = 'expired';
  }

  return upload;
}

/**
 * Get upload by ID (admin access)
 */
export async function getUploadById(uploadId) {
  const result = await db.query(`
    SELECT
      su.*,
      u.email as created_by_email,
      u.first_name as created_by_name
    FROM secure_uploads su
    LEFT JOIN users u ON u.user_id = su.created_by
    WHERE su.upload_id = $1
  `, [uploadId]);

  return result.rows[0] || null;
}

/**
 * Log access to upload portal
 */
export async function logAccess(uploadId, ip, userAgent) {
  await db.query(`
    UPDATE secure_uploads
    SET last_accessed_at = NOW(), access_count = access_count + 1
    WHERE upload_id = $1
  `, [uploadId]);

  await logAuditEvent(uploadId, 'accessed', 'prospect', null, ip, userAgent);
}

/**
 * Accept BAA agreement
 */
export async function acceptBAA(uploadId, signerName, ip, userAgent) {
  const result = await db.query(`
    UPDATE secure_uploads
    SET baa_accepted = true,
        baa_accepted_at = NOW(),
        baa_accepted_ip = $2,
        baa_signer_name = $3
    WHERE upload_id = $1 AND baa_accepted = false
    RETURNING *
  `, [uploadId, ip, signerName]);

  if (result.rows.length === 0) {
    return false;
  }

  await logAuditEvent(uploadId, 'baa_accepted', 'prospect', null, ip, userAgent, {
    signer_name: signerName
  });

  logger.info('BAA accepted', { uploadId, signerName, ip });
  return true;
}

/**
 * Upload and encrypt a file
 */
export async function uploadFile(uploadId, file, ip, userAgent) {
  // Validate upload exists and BAA accepted
  const upload = await getUploadById(uploadId);
  if (!upload) {
    throw new Error('Upload not found');
  }
  if (!upload.baa_accepted) {
    throw new Error('BAA must be accepted before uploading files');
  }
  if (upload.status === 'expired' || new Date(upload.expires_at) < new Date()) {
    throw new Error('Upload link has expired');
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error(`File size exceeds maximum of ${MAX_FILE_SIZE / 1024 / 1024}MB`);
  }

  const fileId = uuidv4();
  const storedFilename = encryption.generateStorageFilename(file.originalname);
  const storedPath = path.join(UPLOAD_DIR, uploadId);

  // Ensure directory exists
  await fs.promises.mkdir(storedPath, { recursive: true });

  const fullPath = path.join(storedPath, storedFilename);

  // Encrypt the file
  const { iv, authTag, size } = await encryptAndSaveFile(file, fullPath);

  // Calculate checksum of original file
  const checksum = encryption.calculateBufferChecksum(file.buffer);

  // Determine file type
  const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
  const fileType = getFileType(ext, file.mimetype);

  // Save file record
  await db.query(`
    INSERT INTO secure_upload_files (
      file_id, upload_id, original_filename, stored_filename,
      file_size_bytes, mime_type, checksum_sha256,
      encrypted, encryption_iv, encryption_tag, file_type
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
    fileId, uploadId, file.originalname, storedFilename,
    file.size, file.mimetype, checksum,
    true, iv, authTag, fileType
  ]);

  // Update upload stats
  await db.query(`
    UPDATE secure_uploads
    SET file_count = file_count + 1,
        total_size_bytes = total_size_bytes + $2,
        status = 'uploaded'
    WHERE upload_id = $1
  `, [uploadId, file.size]);

  await logAuditEvent(uploadId, 'file_uploaded', 'prospect', null, ip, userAgent, {
    file_id: fileId,
    original_filename: file.originalname,
    file_size: file.size,
    file_type: fileType
  });

  logger.info('File uploaded and encrypted', { uploadId, fileId, filename: file.originalname });

  return {
    fileId,
    originalFilename: file.originalname,
    size: file.size,
    type: fileType
  };
}

/**
 * Encrypt and save file from buffer
 */
async function encryptAndSaveFile(file, destPath) {
  const { encrypted, iv, authTag } = encryption.encryptBuffer(file.buffer);
  await fs.promises.writeFile(destPath, encrypted);

  return {
    iv,
    authTag,
    size: encrypted.length
  };
}

/**
 * Get files for an upload
 */
export async function getUploadFiles(uploadId) {
  const result = await db.query(`
    SELECT file_id, original_filename, file_size_bytes, mime_type, file_type, uploaded_at
    FROM secure_upload_files
    WHERE upload_id = $1 AND deleted_at IS NULL
    ORDER BY uploaded_at DESC
  `, [uploadId]);

  return result.rows;
}

/**
 * Delete a file
 */
export async function deleteFile(uploadId, fileId, actorType, actorId, ip, userAgent) {
  // Get file info
  const fileResult = await db.query(`
    SELECT * FROM secure_upload_files
    WHERE file_id = $1 AND upload_id = $2 AND deleted_at IS NULL
  `, [fileId, uploadId]);

  if (fileResult.rows.length === 0) {
    return false;
  }

  const file = fileResult.rows[0];

  // Securely delete the physical file
  const filePath = path.join(UPLOAD_DIR, uploadId, file.stored_filename);
  await encryption.secureDelete(filePath);

  // Soft delete in database
  await db.query(`
    UPDATE secure_upload_files
    SET deleted_at = NOW()
    WHERE file_id = $1
  `, [fileId]);

  // Update upload stats
  await db.query(`
    UPDATE secure_uploads
    SET file_count = file_count - 1,
        total_size_bytes = total_size_bytes - $2
    WHERE upload_id = $1
  `, [uploadId, file.file_size_bytes]);

  await logAuditEvent(uploadId, 'file_deleted', actorType, actorId, ip, userAgent, {
    file_id: fileId,
    original_filename: file.original_filename
  });

  return true;
}

/**
 * Download a file (admin only)
 */
export async function downloadFile(uploadId, fileId, adminId, ip, userAgent) {
  const fileResult = await db.query(`
    SELECT * FROM secure_upload_files
    WHERE file_id = $1 AND upload_id = $2 AND deleted_at IS NULL
  `, [fileId, uploadId]);

  if (fileResult.rows.length === 0) {
    return null;
  }

  const file = fileResult.rows[0];
  const filePath = path.join(UPLOAD_DIR, uploadId, file.stored_filename);

  // Decrypt file to buffer
  const decrypted = await encryption.decryptFileToBuffer(
    filePath,
    file.encryption_iv,
    file.encryption_tag
  );

  await logAuditEvent(uploadId, 'downloaded', 'admin', adminId, ip, userAgent, {
    file_id: fileId,
    original_filename: file.original_filename
  });

  return {
    buffer: decrypted,
    filename: file.original_filename,
    mimeType: file.mime_type
  };
}

/**
 * Extend upload expiration
 */
export async function extendExpiration(uploadId, additionalDays, adminId) {
  const result = await db.query(`
    UPDATE secure_uploads
    SET expires_at = expires_at + ($2 || ' days')::INTERVAL
    WHERE upload_id = $1
    RETURNING expires_at
  `, [uploadId, additionalDays]);

  if (result.rows.length === 0) {
    return null;
  }

  await logAuditEvent(uploadId, 'extended', 'admin', adminId, null, null, {
    additional_days: additionalDays,
    new_expires_at: result.rows[0].expires_at
  });

  return result.rows[0].expires_at;
}

/**
 * Delete an upload and all its files
 */
export async function deleteUpload(uploadId, adminId) {
  // Get all files
  const files = await db.query(`
    SELECT stored_filename FROM secure_upload_files
    WHERE upload_id = $1
  `, [uploadId]);

  // Securely delete all files
  const uploadDir = path.join(UPLOAD_DIR, uploadId);
  for (const file of files.rows) {
    try {
      await encryption.secureDelete(path.join(uploadDir, file.stored_filename));
    } catch (error) {
      logger.error('Failed to delete file', { uploadId, filename: file.stored_filename });
    }
  }

  // Try to remove directory
  try {
    await fs.promises.rmdir(uploadDir);
  } catch (error) {
    // Directory might not be empty or not exist
  }

  // Update status
  await db.query(`
    UPDATE secure_uploads
    SET status = 'deleted'
    WHERE upload_id = $1
  `, [uploadId]);

  await logAuditEvent(uploadId, 'deleted', 'admin', adminId, null, null);

  logger.info('Upload deleted', { uploadId, adminId });
  return true;
}

/**
 * List all uploads (admin)
 */
export async function listUploads(options = {}) {
  const { status, limit = 50, offset = 0 } = options;

  let whereClause = 'WHERE 1=1';
  const params = [];

  if (status) {
    params.push(status);
    whereClause += ` AND su.status = $${params.length}`;
  }

  params.push(limit, offset);

  const result = await db.query(`
    SELECT
      su.*,
      u.email as created_by_email,
      CASE
        WHEN su.expires_at < NOW() THEN 'expired'
        WHEN su.expires_at < NOW() + INTERVAL '3 days' THEN 'expiring_soon'
        ELSE 'active'
      END as expiry_status
    FROM secure_uploads su
    LEFT JOIN users u ON u.user_id = su.created_by
    ${whereClause}
    ORDER BY su.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  return result.rows;
}

/**
 * Get audit log for an upload
 */
export async function getAuditLog(uploadId) {
  const result = await db.query(`
    SELECT
      sal.*,
      COALESCE(u.email, sal.actor_email, 'System') as actor_email
    FROM secure_upload_audit_log sal
    LEFT JOIN users u ON u.user_id = sal.actor_id
    WHERE sal.upload_id = $1
    ORDER BY sal.created_at DESC
  `, [uploadId]);

  return result.rows;
}

/**
 * Cleanup expired uploads
 */
export async function cleanupExpiredUploads() {
  // Get expired uploads
  const expired = await db.query(`
    SELECT upload_id FROM secure_uploads
    WHERE status IN ('pending', 'uploaded')
      AND expires_at < NOW()
  `);

  let cleanedCount = 0;

  for (const { upload_id } of expired.rows) {
    try {
      // Delete files
      const files = await db.query(`
        SELECT stored_filename FROM secure_upload_files WHERE upload_id = $1
      `, [upload_id]);

      const uploadDir = path.join(UPLOAD_DIR, upload_id);
      for (const file of files.rows) {
        try {
          await encryption.secureDelete(path.join(uploadDir, file.stored_filename));
        } catch (error) {
          // File might not exist
        }
      }

      try {
        await fs.promises.rmdir(uploadDir);
      } catch (error) {
        // Directory might not exist
      }

      // Update status
      await db.query(`
        UPDATE secure_uploads SET status = 'expired' WHERE upload_id = $1
      `, [upload_id]);

      await logAuditEvent(upload_id, 'expired', 'system', null, null, null);

      cleanedCount++;
    } catch (error) {
      logger.error('Failed to cleanup upload', { uploadId: upload_id, error: error.message });
    }
  }

  logger.info('Expired uploads cleaned up', { count: cleanedCount });
  return cleanedCount;
}

/**
 * Log audit event
 */
async function logAuditEvent(uploadId, eventType, actorType, actorId, ip, userAgent, details = null) {
  await db.query(`
    INSERT INTO secure_upload_audit_log (
      upload_id, event_type, actor_type, actor_id, actor_ip, user_agent, event_details
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [uploadId, eventType, actorType, actorId, ip, userAgent, details ? JSON.stringify(details) : null]);
}

/**
 * Get file type from extension
 */
function getFileType(ext, mimeType) {
  const typeMap = {
    'csv': 'csv',
    'xlsx': 'excel',
    'xls': 'excel',
    'pdf': 'pdf',
    'txt': 'text',
    'zip': 'archive',
    'gz': 'archive'
  };

  return typeMap[ext] || 'other';
}

export default {
  createUploadLink,
  getUploadByToken,
  getUploadById,
  logAccess,
  acceptBAA,
  uploadFile,
  getUploadFiles,
  deleteFile,
  downloadFile,
  extendExpiration,
  deleteUpload,
  listUploads,
  getAuditLog,
  cleanupExpiredUploads
};
