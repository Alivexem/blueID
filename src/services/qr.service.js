'use strict';

const QRCode = require('qrcode');
const blueIdService = require('./blueId.service');
const ApiError = require('../utils/ApiError');

/**
 * QR code generation for the physical Blue ID card (concept note §4, §5).
 *
 * The encoded payload is an opaque, signed verification token — not the Blue
 * ID, not a name, not a photograph reference. A QR code is scanned by anyone
 * holding a phone, so it must not act as a bearer credential for a profile.
 * The token resolves to a record only through the verification endpoint, which
 * applies its own disclosure rules and rate limits.
 *
 * Error correction is set to 'M': cards carried on fishing boats get wet,
 * scratched and creased, and the extra redundancy costs only a slightly denser
 * symbol.
 */

const DEFAULT_OPTIONS = {
  errorCorrectionLevel: 'M',
  margin: 1,
  width: 320,
  color: { dark: '#0B4F6C', light: '#FFFFFF' },
};

function assertIssued(fisherman) {
  if (!fisherman?.verificationToken) {
    throw ApiError.badRequest(
      'A QR code can only be generated once a Blue ID has been issued',
      { code: 'BLUE_ID_NOT_ISSUED' }
    );
  }
}

/** Resolves the payload URL for a fisherman document. */
function payloadFor(fisherman) {
  assertIssued(fisherman);
  return blueIdService.qrPayload(fisherman.verificationToken, fisherman.qrVersion || 1);
}

/** Data-URL PNG, for embedding in a portal page or a PDF card. */
async function toDataUrl(fisherman, options = {}) {
  const { url } = payloadFor(fisherman);
  return QRCode.toDataURL(url, { ...DEFAULT_OPTIONS, ...options });
}

/** Raw PNG buffer, for a download endpoint or a print run. */
async function toBuffer(fisherman, options = {}) {
  const { url } = payloadFor(fisherman);
  return QRCode.toBuffer(url, { ...DEFAULT_OPTIONS, type: 'png', ...options });
}

/** SVG string — preferred for card printing, since it scales without loss. */
async function toSvg(fisherman, options = {}) {
  const { url } = payloadFor(fisherman);
  return QRCode.toString(url, { ...DEFAULT_OPTIONS, type: 'svg', ...options });
}

/**
 * Validates a scanned code's signature without a database lookup.
 * Proves the card is genuine; the caller still resolves the token to a record
 * for live status.
 */
function verifyScan(scanned) {
  const parsed = blueIdService.parseQrPayload(scanned);

  if (!parsed?.token) {
    return { valid: false, reason: 'UNREADABLE', token: null };
  }

  const signatureValid = blueIdService.verifySignature(parsed.token, parsed.version, parsed.signature);

  return {
    valid: signatureValid,
    reason: signatureValid ? null : 'BAD_SIGNATURE',
    token: parsed.token,
    version: parsed.version,
  };
}

module.exports = { toDataUrl, toBuffer, toSvg, verifyScan, payloadFor, DEFAULT_OPTIONS };
