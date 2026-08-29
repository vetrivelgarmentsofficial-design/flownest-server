import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // Standard for GCM
const TAG_LENGTH = 16;

// Load encryption key from environment, fallback for testing
const encryptionKeyHex = process.env.ENCRYPTION_KEY;

if (!encryptionKeyHex) {
  console.warn('WARNING: ENCRYPTION_KEY environment variable is not set. Application layer encryption will use a fallback, which is insecure for production!');
}

// Ensure key is 32 bytes (64 hex characters)
const ENCRYPTION_KEY = Buffer.from(
  encryptionKeyHex && encryptionKeyHex.length === 64
    ? encryptionKeyHex
    : '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);

if (ENCRYPTION_KEY.length !== 32) {
  throw new Error('Encryption key must be exactly 32 bytes (64 hex characters)');
}

/**
 * Encrypts a string using AES-256-GCM
 * Output format: hex(iv) + ":" + hex(authTag) + ":" + hex(encryptedText)
 */
export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM encrypted string
 */
export function decrypt(cipherText: string): string {
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid cipher text format. Expected iv:tag:encryptedText');
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
