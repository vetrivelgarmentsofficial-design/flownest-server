import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 12 bytes IV is standard for GCM

const encryptionKeyHex = process.env.ENCRYPTION_KEY;

if (!encryptionKeyHex) {
  console.warn('WARNING: ENCRYPTION_KEY is not defined in the environment. Using fallback key.');
}

const KEY = Buffer.from(
  encryptionKeyHex && encryptionKeyHex.length === 64
    ? encryptionKeyHex
    : '0000000000000000000000000000000000000000000000000000000000000000',
  'hex'
);

if (KEY.length !== 32) {
  throw new Error('Encryption key must be exactly 32 bytes (64 hex characters)');
}

/**
 * Checks if a string matches the encrypted payload format: "ivHex:tagHex:encryptedHex"
 */
export function isEncrypted(text: string): boolean {
  if (typeof text !== 'string') return false;
  const parts = text.split(':');
  if (parts.length !== 3) return false;
  const [iv, tag, cipher] = parts;
  const hexRegex = /^[0-9a-fA-F]+$/;
  return iv.length === 24 && tag.length === 32 && hexRegex.test(iv) && hexRegex.test(tag) && hexRegex.test(cipher);
}

/**
 * Encrypts clear text using AES-256-GCM.
 * Returns a formatted string: "ivHex:tagHex:encryptedHex"
 */
export function encrypt(text: string): string {
  if (isEncrypted(text)) {
    return text;
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM cipher text.
 * Expects formatted string: "ivHex:tagHex:encryptedHex"
 */
export function decrypt(cipherText: string): string {
  if (!isEncrypted(cipherText)) {
    return cipherText;
  }
  const parts = cipherText.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encryption payload. Expected format iv:tag:encrypted');
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, undefined, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

