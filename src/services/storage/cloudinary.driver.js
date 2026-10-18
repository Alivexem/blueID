'use strict';

const { cloudinary, isEnabled } = require('../../config/cloudinary');
const config = require('../../config');
const logger = require('../../config/logger');

/**
 * Cloudinary media storage, kept behind the same interface as the local
 * driver so a deployment can move either way without touching a call site.
 *
 * Retained as the alternative rather than deleted: it is the fallback if the
 * server's disk proves unworkable, and it is what existing records point at
 * until the migration script has run.
 */

/**
 * Metadata stripped from every upload.
 *
 * A photograph taken on a field device carries EXIF, and EXIF carries GPS.
 * The explicit angle bakes in rotation before the EXIF that encoded it is
 * discarded.
 */
const PRIVACY_OPTIONS = Object.freeze({
  image_metadata: false,
  angle: 'exif',
  invalidate: true,
});

function uploadBuffer(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { ...PRIVACY_OPTIONS, ...options },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
  });
}

function toMediaRecord(result) {
  return {
    url: result.secure_url,
    publicId: result.public_id,
    width: result.width,
    height: result.height,
    format: result.format,
    bytes: result.bytes,
    uploadedAt: new Date(),
  };
}

/**
 * `square` maps to a face-centred crop, matching what the local driver does
 * with sharp's attention strategy, so a passport photograph is framed the
 * same way whichever driver stored it.
 */
async function put(buffer, { publicId, square = false, maxEdge = 1024, folder, tags = [] } = {}) {
  const transformation = square
    ? [
        { width: 400, height: 400, crop: 'thumb', gravity: 'face' },
        { quality: 'auto:good', fetch_format: 'auto' },
      ]
    : [{ width: maxEdge, crop: 'limit' }, { quality: 'auto:good', fetch_format: 'auto' }];

  const result = await uploadBuffer(buffer, {
    folder,
    public_id: publicId || undefined,
    overwrite: Boolean(publicId),
    resource_type: 'image',
    type: 'authenticated',
    transformation,
    tags: tags.filter(Boolean),
  });

  return toMediaRecord(result);
}

function signedUrl(publicId, { expiresInSeconds = 600, transformation } = {}) {
  if (!publicId) return null;
  return cloudinary.url(publicId, {
    type: 'authenticated',
    sign_url: true,
    secure: true,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    ...(transformation ? { transformation } : {}),
  });
}

async function destroy(publicId) {
  if (!publicId || !isEnabled()) return false;
  try {
    const result = await cloudinary.uploader.destroy(publicId, { type: 'authenticated' });
    return result.result === 'ok';
  } catch (err) {
    logger.warn({ err, publicId }, 'Media deletion failed');
    return false;
  }
}

/**
 * Credentials for a direct device -> Cloudinary upload, so a device coming
 * back online with a day of photographs does not push them all through the
 * API. The local driver has no equivalent; see media.service.js.
 */
function createUploadSignature({ folder, publicId, tags = [] }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    timestamp,
    folder: folder || config.cloudinary.folder,
    type: 'authenticated',
    ...(publicId ? { public_id: publicId } : {}),
    ...(tags.length ? { tags: tags.join(',') } : {}),
    ...(config.cloudinary.uploadPreset ? { upload_preset: config.cloudinary.uploadPreset } : {}),
  };

  const signature = cloudinary.utils.api_sign_request(params, config.cloudinary.apiSecret);

  return {
    ...params,
    signature,
    apiKey: config.cloudinary.apiKey,
    cloudName: config.cloudinary.cloudName,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/image/upload`,
  };
}

async function healthCheck() {
  return { ok: isEnabled(), provider: 'cloudinary' };
}

module.exports = {
  name: 'cloudinary',
  put,
  signedUrl,
  destroy,
  createUploadSignature,
  healthCheck,
  isEnabled,
  toMediaRecord,
  // Not applicable to a remote store; present so the interface is uniform.
  verifySignature: () => false,
  ensureRootSync: () => {},
};
