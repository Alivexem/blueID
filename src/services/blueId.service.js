'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const { LGA_BY_CODE } = require('../config/constants');
const Counter = require('../modules/fishermen/counter.repository');
const ApiError = require('../utils/ApiError');

/**
 * Blue ID issuance and verification.
 *
 * Format: CRS-BLU-BAK-0001
 *   CRS  state prefix
 *   BLU  Blue Economy / fisheries identification
 *   BAK  Local Government Area code
 *   0001 zero-padded sequence, unique within that LGA
 *
 * The number is permanent — it is printed on a physical card and becomes the
 * fisherman's reference for every future intervention. Three consequences:
 *
 *   - Sequences come from an atomic counter, never from a COUNT of rows, so
 *     concurrent sync batches cannot collide.
 *   - A number is never reused, even if a record is later deleted or merged.
 *   - Padding is a display convention only; once a LGA passes 9999 the number
 *     simply grows to five digits rather than wrapping.
 */

const SEPARATOR = '-';

function counterKeyFor(lgaCode) {
  return `blueid:${lgaCode}`;
}

function format(lgaCode, sequence) {
  const padded = String(sequence).padStart(config.blueId.padding, '0');
  return [config.blueId.prefix, config.blueId.segment, lgaCode, padded].join(SEPARATOR);
}

/**
 * Reserves the next Blue ID for an LGA. Pass the sync batch's session so the
 * number is released if the surrounding transaction rolls back.
 */
async function issue(lgaCode, session = null) {
  const code = String(lgaCode || '').toUpperCase();
  if (!LGA_BY_CODE[code]) {
    throw ApiError.badRequest(`Unknown Local Government Area code: ${lgaCode}`, {
      code: 'UNKNOWN_LGA',
    });
  }
  const sequence = await Counter.next(counterKeyFor(code), session);
  return { blueId: format(code, sequence), sequence, lga: code };
}

const BLUE_ID_PATTERN = /^([A-Z]{2,4})-([A-Z]{2,4})-([A-Z]{2,4})-(\d{3,8})$/;

/** Parses a Blue ID without touching the database. */
function parse(blueId) {
  if (!blueId) return null;
  const match = BLUE_ID_PATTERN.exec(String(blueId).trim().toUpperCase());
  if (!match) return null;

  const [, prefix, segment, lga, sequence] = match;
  return { prefix, segment, lga, sequence: Number(sequence), formatted: match[0] };
}

/** Structural validity plus a known LGA — not proof the record exists. */
function isWellFormed(blueId) {
  const parsed = parse(blueId);
  return Boolean(
    parsed &&
      parsed.prefix === config.blueId.prefix &&
      parsed.segment === config.blueId.segment &&
      LGA_BY_CODE[parsed.lga]
  );
}

/**
 * Temporary reference printed on the paper slip given to a fisherman in the
 * field, before the record has reached the server and been issued a real
 * Blue ID. Deliberately distinguishable from a true Blue ID (TMP- prefix) so
 * it can never be mistaken for one on a card or in a report.
 */
function temporaryReference(deviceCode, clientRecordId) {
  const suffix = String(clientRecordId || crypto.randomUUID())
    .replace(/-/g, '')
    .slice(-6)
    .toUpperCase();
  return `TMP-${String(deviceCode || 'FIELD').toUpperCase()}-${suffix}`;
}

function isTemporaryReference(value) {
  return typeof value === 'string' && value.toUpperCase().startsWith('TMP-');
}

/**
 * Signs an opaque verification token for the QR code on the physical card.
 *
 * The QR carries a RANDOM TOKEN, never the Blue ID and never a name. A card
 * photographed across a table therefore leaks nothing: the token is
 * meaningless without a call to the verification endpoint, which decides what
 * to disclose and to whom.
 *
 * The HMAC alongside it preserves the one property that encoding the Blue ID
 * used to give — an official with no network can still confirm the card was
 * produced by this system rather than printed by hand. Live status always
 * requires a lookup.
 */
function sign(token, version = 1) {
  if (!config.blueId.qrSecret) {
    throw ApiError.unavailable('QR signing is not configured (QR_SIGNING_SECRET)');
  }
  return crypto
    .createHmac('sha256', config.blueId.qrSecret)
    .update(`${token}.${version}`)
    .digest('base64url')
    .slice(0, 24);
}

function verifySignature(token, version, signature) {
  if (!token || !signature) return false;
  try {
    const expected = sign(token, version);
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * The payload encoded into the printed QR code.
 * Contains only the opaque token, its version and the signature.
 */
function qrPayload(verificationToken, version = 1) {
  if (!verificationToken) {
    throw ApiError.badRequest('This record has no verification token — issue a Blue ID first', {
      code: 'NO_VERIFICATION_TOKEN',
    });
  }
  const signature = sign(verificationToken, version);
  const url = new URL(config.blueId.verificationBaseUrl);
  url.searchParams.set('t', verificationToken);
  url.searchParams.set('v', String(version));
  url.searchParams.set('sig', signature);
  return { url: url.toString(), token: verificationToken, version, signature };
}

/** Reads a scanned QR string back into its parts. */
function parseQrPayload(scanned) {
  if (!scanned) return null;
  try {
    // Accept either the full URL or a bare "token|version|signature".
    if (scanned.includes('://')) {
      const url = new URL(scanned);
      return {
        token: url.searchParams.get('t'),
        version: Number(url.searchParams.get('v') || 1),
        signature: url.searchParams.get('sig'),
      };
    }
    const [token, version, signature] = scanned.split('|');
    return { token, version: Number(version || 1), signature };
  } catch {
    return null;
  }
}

/**
 * After importing a legacy register, raise each LGA counter above the highest
 * imported sequence so new issuance cannot collide with it.
 */
async function reconcileCounter(lgaCode, highestSequence) {
  await Counter.ensureAtLeast(counterKeyFor(lgaCode), highestSequence);
}

async function currentSequence(lgaCode) {
  return Counter.peek(counterKeyFor(String(lgaCode).toUpperCase()));
}

module.exports = {
  issue,
  format,
  parse,
  isWellFormed,
  temporaryReference,
  isTemporaryReference,
  sign,
  verifySignature,
  qrPayload,
  parseQrPayload,
  reconcileCounter,
  currentSequence,
  BLUE_ID_PATTERN,
};
