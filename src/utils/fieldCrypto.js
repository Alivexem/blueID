'use strict';

const crypto = require('node:crypto');

/**
 * Application-level encryption for high-risk identifiers (the NIN).
 *
 * Disk encryption protects a stolen volume; it does nothing against a leaked
 * backup, an over-broad database user or an accidental export. The NIN is the
 * one field in this register that is both durable and nationally sensitive, so
 * it is encrypted by the application with a key held outside the database.
 *
 * The problem encryption creates here is matching: duplicate detection needs
 * to ask "does anyone else have this NIN?", and AES-GCM is randomised, so two
 * encryptions of the same NIN differ. The solution is a BLIND INDEX — a keyed
 * HMAC of the normalised value, stored alongside the ciphertext and indexed.
 * Equality search works; the index reveals nothing without the key.
 *
 * Both keys are derived from one master secret so operators manage one value,
 * and they are derived with distinct labels so the index key can never be used
 * to decrypt.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard
const VERSION = 'v1'; // lets a future key rotation be detected on read

let encryptionKey = null;
let blindIndexKey = null;
let enabled = false;

/**
 * Derives the two subkeys from the configured master secret.
 * Called once at require time; safe to call again after a config reload.
 */
function initialise(masterSecret) {
  if (!masterSecret) {
    enabled = false;
    encryptionKey = null;
    blindIndexKey = null;
    return false;
  }

  // HKDF with distinct info labels gives two independent 32-byte keys.
  const salt = Buffer.from('blueid-field-encryption');
  encryptionKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(masterSecret), salt, Buffer.from('encrypt'), 32)
  );
  blindIndexKey = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(masterSecret), salt, Buffer.from('blind-index'), 32)
  );
  enabled = true;
  return true;
}

/**
 * Encrypts a value to a self-describing string:
 *   v1:<iv-b64>:<authTag-b64>:<ciphertext-b64>
 *
 * Returns the plaintext unchanged when encryption is not configured, so a
 * development environment still works — `isEnabled()` reports the difference
 * and the config layer refuses an unconfigured production boot.
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  if (!enabled) return String(plaintext);

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    ':'
  );
}

/**
 * Reverses `encrypt`. A value that is not in the ciphertext format is returned
 * as-is, so records written before encryption was switched on still read.
 */
function decrypt(value) {
  if (value == null || value === '') return value;
  if (!enabled || !isCiphertext(value)) return value;

  try {
    const [, ivB64, tagB64, dataB64] = String(value).split(':');
    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    // A failure here means a wrong key or a tampered record. Surfacing null
    // rather than throwing keeps one bad row from breaking a whole listing;
    // the mismatch is visible because the field reads as unavailable.
    return null;
  }
}

function isCiphertext(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}:`) && value.split(':').length === 4;
}

/**
 * Deterministic keyed hash for equality search on an encrypted field.
 * The same input always produces the same index; without the key the index
 * cannot be reversed or brute-forced across the small NIN keyspace.
 */
function blindIndex(value) {
  if (value == null || value === '') return undefined;
  if (!enabled) {
    // Without a key, fall back to a plain hash so matching still functions in
    // development. Never used in production — config enforces the key there.
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
  }
  return crypto.createHmac('sha256', blindIndexKey).update(String(value)).digest('hex').slice(0, 32);
}

/** Masks an identifier for display to users without the sensitive grant. */
function mask(value, { keepLast = 4 } = {}) {
  if (!value) return value;
  const str = String(value);
  if (str.length <= keepLast) return '*'.repeat(str.length);
  return `${'*'.repeat(str.length - keepLast)}${str.slice(-keepLast)}`;
}

const isEnabled = () => enabled;

// Initialised from config at startup; config requires a key in production.
initialise(process.env.FIELD_ENCRYPTION_KEY);

module.exports = {
  initialise,
  encrypt,
  decrypt,
  blindIndex,
  mask,
  isCiphertext,
  isEnabled,
};
