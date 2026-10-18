'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const config = require('../../config');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');

/**
 * Filesystem media storage.
 *
 * Images live on the server's own disk rather than a third-party service.
 * For this register that is a compliance position as much as an operational
 * one: NITDA's National Cloud Policy places biometric and identity data in a
 * tier that must be stored in Nigeria at rest, and a passport photograph tied
 * to a NIN in a government identity register sits squarely in it.
 *
 * WHAT THIS FILE IS RESPONSIBLE FOR
 *
 *   1. Normalising an upload    resize, re-encode, strip EXIF
 *   2. Writing it atomically    temp file + rename, never a half-written image
 *   3. Addressing it safely     no caller-supplied path escapes the root
 *   4. Minting expiring URLs    a path on its own grants nothing
 *
 * WHAT IT DOES NOT DO
 *
 * Back itself up. The database has a backup drill; this directory needs its
 * own, off the box, and it is the half people forget. A lost photograph
 * cannot be regenerated from anything — it means visiting the fisherman
 * again. See OPERATIONS.md.
 */

/**
 * A public id is the asset's relative path with no extension. It is recorded
 * on the document, arrives back in URLs, and is therefore treated as hostile:
 * anything outside this alphabet is refused before it reaches the filesystem.
 */
const PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9/_-]{0,200}$/;

const EXTENSION = 'jpg';

function assertSafePublicId(publicId) {
  const value = String(publicId || '');
  if (!PUBLIC_ID.test(value) || value.includes('..') || value.includes('//')) {
    throw ApiError.badRequest('Invalid media reference', { code: 'MEDIA_ID_INVALID' });
  }
  return value;
}

/**
 * Resolves a public id to a path, then proves the result is still inside the
 * media root. The regex above should make this unreachable; it is kept
 * because a traversal bug here discloses arbitrary server files, and two
 * cheap checks are worth more than one clever one.
 */
function absolutePathFor(publicId) {
  const safe = assertSafePublicId(publicId);
  const root = path.resolve(config.media.root);
  const full = path.resolve(root, `${safe}.${EXTENSION}`);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw ApiError.badRequest('Invalid media reference', { code: 'MEDIA_ID_INVALID' });
  }
  return full;
}

/** Two hex characters off the id, so no directory collects every record. */
function shardFor(seed) {
  return crypto.createHash('sha1').update(String(seed)).digest('hex').slice(0, 2);
}

function randomId() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * Re-encodes an upload to a stored image.
 *
 * `rotate()` with no argument applies the EXIF orientation and then discards
 * it, which is the only way to honour how a photograph was held without
 * keeping the metadata block that also carries GPS coordinates. sharp writes
 * no metadata unless asked, so the location of a citizen's registration does
 * not travel inside their photograph.
 */
async function normalise(buffer, { square = false, maxEdge = config.media.maxEdge } = {}) {
  const pipeline = sharp(buffer, { failOn: 'error' }).rotate();

  if (square) {
    pipeline.resize(maxEdge, maxEdge, { fit: 'cover', position: sharp.strategy.attention });
  } else {
    pipeline.resize(maxEdge, maxEdge, { fit: 'inside', withoutEnlargement: true });
  }

  const { data, info } = await pipeline
    .jpeg({ quality: config.media.jpegQuality, progressive: true, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

  return { data, width: info.width, height: info.height, bytes: info.size };
}

/** Writes through a temporary file so a reader never sees a partial image. */
async function writeAtomic(destination, data) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${randomId()}.tmp`;
  try {
    await fs.writeFile(temp, data, { mode: 0o640 });
    await fs.rename(temp, destination);
  } catch (err) {
    await fs.unlink(temp).catch(() => {});
    throw err;
  }
}

async function put(buffer, { publicId, square = false, maxEdge } = {}) {
  const id = assertSafePublicId(publicId);
  const destination = absolutePathFor(id);

  let image;
  try {
    image = await normalise(buffer, { square, maxEdge });
  } catch (err) {
    // sharp refuses a file that is not a decodable image. The upload
    // middleware already checks magic bytes, so reaching here means a
    // truncated or corrupt file rather than a wrong type.
    throw ApiError.badRequest('That image could not be read', {
      code: 'MEDIA_UNREADABLE',
      cause: err,
    });
  }

  await writeAtomic(destination, image.data);

  return {
    url: deliveryPath(id),
    publicId: id,
    width: image.width,
    height: image.height,
    format: EXTENSION,
    bytes: image.bytes,
    uploadedAt: new Date(),
  };
}

/** The unsigned path recorded on the document. Not usable on its own. */
function deliveryPath(publicId) {
  return `${config.app.apiPrefix}/media/file/${publicId}.${EXTENSION}`;
}

/**
 * Signature over the path and its expiry.
 *
 * Keyed HMAC rather than a bare hash: a plain digest of a guessable path is
 * forgeable by anyone who works out the scheme.
 */
function sign(publicId, expiresAt) {
  return crypto
    .createHmac('sha256', config.media.urlSecret)
    .update(`${publicId}:${expiresAt}`)
    .digest('base64url');
}

function signedUrl(publicId, { expiresInSeconds = 600 } = {}) {
  if (!publicId) return null;
  const id = assertSafePublicId(publicId);
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const base = config.app.baseUrl ? config.app.baseUrl.replace(/\/+$/, '') : '';
  return `${base}${deliveryPath(id)}?e=${expiresAt}&s=${sign(id, expiresAt)}`;
}

/**
 * Checks a delivery signature. Compared in constant time, because a timing
 * leak here is an offline forgery oracle.
 */
function verifySignature(publicId, expiresAt, signature) {
  if (!publicId || !expiresAt || !signature) return false;

  const expiry = Number(expiresAt);
  if (!Number.isInteger(expiry) || expiry < Math.floor(Date.now() / 1000)) return false;

  let expected;
  try {
    expected = sign(assertSafePublicId(publicId), expiry);
  } catch {
    return false;
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function destroy(publicId) {
  if (!publicId) return false;
  try {
    await fs.unlink(absolutePathFor(publicId));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    logger.warn({ err, publicId }, 'Media deletion failed');
    return false;
  }
}

async function exists(publicId) {
  try {
    await fs.access(absolutePathFor(publicId));
    return true;
  } catch {
    return false;
  }
}

async function stat(publicId) {
  try {
    return await fs.stat(absolutePathFor(publicId));
  } catch {
    return null;
  }
}

/**
 * Readiness: the root must exist and be writable. A read-only or unmounted
 * volume is otherwise discovered on the first upload of the working day,
 * which is the worst moment to find out.
 */
async function healthCheck() {
  const root = path.resolve(config.media.root);
  try {
    await fs.mkdir(root, { recursive: true });
    const probe = path.join(root, `.write-probe-${randomId()}`);
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return { ok: true, root };
  } catch (err) {
    return { ok: false, root, error: err.code || err.message };
  }
}

function isEnabled() {
  return Boolean(config.media.urlSecret);
}

/** Ensures the root exists at boot rather than on first write. */
function ensureRootSync() {
  try {
    fsSync.mkdirSync(path.resolve(config.media.root), { recursive: true });
  } catch (err) {
    logger.error({ err, root: config.media.root }, 'Could not create the media root');
  }
}

module.exports = {
  name: 'local',
  put,
  signedUrl,
  verifySignature,
  destroy,
  exists,
  stat,
  healthCheck,
  isEnabled,
  ensureRootSync,
  absolutePathFor,
  assertSafePublicId,
  deliveryPath,
  shardFor,
  randomId,
  EXTENSION,
};
