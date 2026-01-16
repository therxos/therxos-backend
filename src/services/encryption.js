/**
 * Encryption Service for TheRxOS V2
 * Provides AES-256-GCM encryption for HIPAA-compliant file storage
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { logger } from '../utils/logger.js';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;  // 128 bits
const AUTH_TAG_LENGTH = 16;  // 128 bits
const KEY_LENGTH = 32;  // 256 bits

// Get encryption key from environment or generate warning
function getEncryptionKey() {
  const keyHex = process.env.UPLOAD_ENCRYPTION_KEY;

  if (!keyHex) {
    logger.warn('UPLOAD_ENCRYPTION_KEY not set - using derived key (NOT RECOMMENDED FOR PRODUCTION)');
    // Derive a key from a combination of secrets (fallback only)
    const fallbackSecret = process.env.JWT_SECRET || 'therxos-default-key-change-me';
    return crypto.scryptSync(fallbackSecret, 'therxos-salt', KEY_LENGTH);
  }

  // Key should be 64 hex characters (32 bytes)
  if (keyHex.length !== 64) {
    throw new Error('UPLOAD_ENCRYPTION_KEY must be 64 hex characters (256 bits)');
  }

  return Buffer.from(keyHex, 'hex');
}

/**
 * Generate a random initialization vector
 */
export function generateIV() {
  return crypto.randomBytes(IV_LENGTH);
}

/**
 * Generate a secure random token
 */
export function generateSecureToken(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

/**
 * Generate a random filename for storage
 */
export function generateStorageFilename(originalFilename) {
  const ext = path.extname(originalFilename);
  const randomName = crypto.randomBytes(16).toString('hex');
  return `${randomName}${ext}.enc`;
}

/**
 * Encrypt a buffer
 * @param {Buffer} data - Data to encrypt
 * @returns {Object} - { encrypted: Buffer, iv: string (hex), authTag: string (hex) }
 */
export function encryptBuffer(data) {
  const key = getEncryptionKey();
  const iv = generateIV();

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex')
  };
}

/**
 * Decrypt a buffer
 * @param {Buffer} encrypted - Encrypted data
 * @param {string} ivHex - IV in hex format
 * @param {string} authTagHex - Auth tag in hex format
 * @returns {Buffer} - Decrypted data
 */
export function decryptBuffer(encrypted, ivHex, authTagHex) {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Encrypt a file and save to destination
 * @param {string} sourcePath - Path to source file
 * @param {string} destPath - Path to save encrypted file
 * @returns {Object} - { iv: string, authTag: string, size: number }
 */
export async function encryptFile(sourcePath, destPath) {
  const key = getEncryptionKey();
  const iv = generateIV();

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const sourceStream = fs.createReadStream(sourcePath);
  const destStream = fs.createWriteStream(destPath);

  // Track size
  let size = 0;
  const sizeTracker = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(null, chunk);
    }
  });

  await pipeline(sourceStream, cipher, sizeTracker, destStream);

  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    size
  };
}

/**
 * Decrypt a file and save to destination
 * @param {string} sourcePath - Path to encrypted file
 * @param {string} destPath - Path to save decrypted file
 * @param {string} ivHex - IV in hex format
 * @param {string} authTagHex - Auth tag in hex format
 */
export async function decryptFile(sourcePath, destPath, ivHex, authTagHex) {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const sourceStream = fs.createReadStream(sourcePath);
  const destStream = fs.createWriteStream(destPath);

  await pipeline(sourceStream, decipher, destStream);
}

/**
 * Decrypt a file and return as buffer (for streaming to response)
 * @param {string} sourcePath - Path to encrypted file
 * @param {string} ivHex - IV in hex format
 * @param {string} authTagHex - Auth tag in hex format
 * @returns {Buffer} - Decrypted file contents
 */
export async function decryptFileToBuffer(sourcePath, ivHex, authTagHex) {
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const encrypted = await fs.promises.readFile(sourcePath);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Calculate SHA-256 checksum of a file
 * @param {string} filePath - Path to file
 * @returns {string} - SHA-256 hash in hex format
 */
export async function calculateChecksum(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Calculate SHA-256 checksum of a buffer
 * @param {Buffer} data - Data to hash
 * @returns {string} - SHA-256 hash in hex format
 */
export function calculateBufferChecksum(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Securely delete a file by overwriting with random data
 * @param {string} filePath - Path to file to delete
 * @param {number} passes - Number of overwrite passes (default 3)
 */
export async function secureDelete(filePath, passes = 3) {
  try {
    const stats = await fs.promises.stat(filePath);
    const size = stats.size;

    for (let i = 0; i < passes; i++) {
      // Overwrite with random data
      const randomData = crypto.randomBytes(size);
      await fs.promises.writeFile(filePath, randomData);
    }

    // Final delete
    await fs.promises.unlink(filePath);

    logger.info('File securely deleted', { filePath, passes });
  } catch (error) {
    logger.error('Secure delete failed', { filePath, error: error.message });
    // Try regular delete as fallback
    try {
      await fs.promises.unlink(filePath);
    } catch (e) {
      // Ignore if file doesn't exist
    }
  }
}

/**
 * Generate a new encryption key (for key rotation)
 * @returns {string} - 64-character hex string
 */
export function generateEncryptionKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('hex');
}

/**
 * Validate encryption key format
 * @param {string} keyHex - Key in hex format
 * @returns {boolean}
 */
export function validateEncryptionKey(keyHex) {
  if (!keyHex || typeof keyHex !== 'string') return false;
  if (keyHex.length !== 64) return false;
  return /^[0-9a-fA-F]+$/.test(keyHex);
}

export default {
  generateIV,
  generateSecureToken,
  generateStorageFilename,
  encryptBuffer,
  decryptBuffer,
  encryptFile,
  decryptFile,
  decryptFileToBuffer,
  calculateChecksum,
  calculateBufferChecksum,
  secureDelete,
  generateEncryptionKey,
  validateEncryptionKey
};
