'use strict';

const crypto = require('node:crypto');
const storage = require('./storage');
const config = require('../config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

/**
 * Media handling, independent of where the bytes end up.
 *
 * This module decides WHAT an image is called and HOW it should be framed;
 * `services/storage` decides WHERE it goes. Photographs of registered
 * citizens are never reachable from a bare URL under either driver — a
 * signed, expiring link is minted per request for staff entitled to see the
 * image, so the register's personal data stays behind the same authorisation
 * rules as the database records themselves (concept note §9).
 */

function assertEnabled() {
  if (!storage.isEnabled()) {
    throw ApiError.unavailable('Media storage is not configured', { code: 'MEDIA_UNAVAILABLE' });
  }
}

/** Keeps a path segment inside the public-id alphabet. */
function slug(value, fallback = 'unknown') {
  const cleaned = String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function shard(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 2);
}

const randomId = () => crypto.randomBytes(12).toString('hex');

/**
 * Where each kind of image is filed.
 *
 * A fisherman's photograph is addressed by Blue ID, so a device retrying an
 * upload overwrites its own earlier attempt instead of leaving an orphan —
 * the same idempotency the record sync relies on. Assets and
 * acknowledgements have no such natural key and get a random one.
 *
 * The two-character shard keeps any one directory from collecting every
 * record in an LGA; at state-wide scale that is the difference between a
 * directory listing that returns and one that does not.
 */
function locate(kind, parts = {}) {
  switch (kind) {
    case 'fisherman': {
      const lga = slug(parts.lga, 'unassigned');
      const key = slug(parts.blueId || parts.clientRecordId || randomId());
      return {
        publicId: `fishermen/${lga}/${shard(key)}/${key}`,
        folder: `${config.cloudinary.folder}/fishermen/${lga}`,
        tags: ['fisherman', 'passport', parts.lga].filter(Boolean),
        square: true,
        maxEdge: 400,
      };
    }
    case 'asset': {
      const lga = slug(parts.lga, 'unassigned');
      const type = slug(parts.kind, 'asset').toLowerCase();
      const key = randomId();
      return {
        publicId: `assets/${type}/${lga}/${shard(key)}/${key}`,
        folder: `${config.cloudinary.folder}/assets/${type}/${lga}`,
        tags: [type, parts.lga, parts.ownerBlueId].filter(Boolean),
        square: false,
        maxEdge: 1024,
      };
    }
    case 'acknowledgement': {
      const programme = slug(parts.programmeCode, 'general');
      const key = parts.blueId ? `${slug(parts.blueId)}-${Date.now()}` : randomId();
      return {
        publicId: `acknowledgements/${programme}/${shard(key)}/${key}`,
        folder: `${config.cloudinary.folder}/acknowledgements/${programme}`,
        tags: ['acknowledgement', parts.programmeCode].filter(Boolean),
        square: false,
        maxEdge: 1200,
      };
    }
    default:
      throw new Error(`Unknown media kind: ${kind}`);
  }
}

async function store(kind, buffer, parts, logContext) {
  assertEnabled();
  const placement = locate(kind, parts);
  try {
    return await storage.put(buffer, placement);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    logger.error({ err, driver: storage.name, ...logContext }, `${kind} upload failed`);
    throw ApiError.internal('Could not upload the image', { cause: err });
  }
}

/**
 * A fisherman's passport photograph: square, face-centred, 400px, so the
 * portal, the printed ID card and the field app all read the same asset.
 */
function uploadFishermanPhoto(buffer, { lga, blueId, clientRecordId } = {}) {
  return store('fisherman', buffer, { lga, blueId, clientRecordId }, { lga, blueId });
}

function uploadAssetPhoto(buffer, { kind, lga, ownerBlueId } = {}) {
  return store('asset', buffer, { kind, lga, ownerBlueId }, { kind, lga });
}

/** Proof-of-delivery slip or signature captured at a programme handover. */
function uploadAcknowledgement(buffer, { programmeCode, blueId } = {}) {
  return store('acknowledgement', buffer, { programmeCode, blueId }, { programmeCode });
}

/**
 * Short-lived signed URL. Default 10 minutes — long enough to render a portal
 * page or an export, short enough that a copied link is useless by the time
 * it is forwarded.
 */
function signedUrl(publicId, options = {}) {
  if (!publicId) return null;
  assertEnabled();
  return storage.signedUrl(publicId, options);
}

/** Replaces the stored path on a media subdocument with a signed URL. */
function withSignedUrl(media, options) {
  if (!media?.publicId) return media;
  try {
    const plain = typeof media.toObject === 'function' ? media.toObject() : media;
    return { ...plain, url: signedUrl(plain.publicId, options) };
  } catch {
    return media;
  }
}

/**
 * Upload credentials for a field device.
 *
 * With Cloudinary this returns a signature for a direct device-to-service
 * upload, keeping a day's photographs off the API. The local driver has no
 * equivalent — the server IS the store — so it returns the endpoint to post
 * to instead. Clients must branch on `strategy`, which is why it is stated
 * explicitly rather than inferred from which fields are present.
 */
function createUploadSignature({ folder, publicId, tags = [] } = {}) {
  assertEnabled();

  if (typeof storage.createUploadSignature === 'function') {
    return { strategy: 'direct', ...storage.createUploadSignature({ folder, publicId, tags }) };
  }

  return {
    strategy: 'api-upload',
    uploadUrl: `${config.app.baseUrl || ''}${config.app.apiPrefix}/media/upload`,
    method: 'POST',
    field: 'file',
    maxBytes: config.cloudinary.maxUploadBytes,
    note: 'This deployment stores media on its own server. Post the image to uploadUrl with a Bearer token; there is no third-party endpoint to upload to.',
  };
}

/**
 * Removes a stored image. Used when a photograph is replaced; a record is
 * soft-deleted rather than destroyed, so this is never called when a
 * fisherman is deleted.
 */
function destroy(publicId) {
  if (!publicId) return Promise.resolve(false);
  return storage.destroy(publicId);
}

/** Deterministic id so a device retrying an upload overwrites itself. */
function deterministicPublicId(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 20);
}

function verifySignature(publicId, expiresAt, signature) {
  return storage.verifySignature(publicId, expiresAt, signature);
}

const isEnabled = () => storage.isEnabled();
const healthCheck = () => storage.healthCheck();

module.exports = {
  uploadFishermanPhoto,
  uploadAssetPhoto,
  uploadAcknowledgement,
  createUploadSignature,
  signedUrl,
  withSignedUrl,
  verifySignature,
  destroy,
  deterministicPublicId,
  healthCheck,
  isEnabled,
  driver: storage.name,
  locate,
};
