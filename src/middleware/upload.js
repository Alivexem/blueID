'use strict';

const multer = require('multer');
const config = require('../config');
const ApiError = require('../utils/ApiError');

/**
 * Files are buffered in memory and streamed straight to Cloudinary — nothing
 * touches the API server's disk. Photographs are small (a 400px passport crop)
 * and the limit below keeps a malicious upload from exhausting memory.
 */

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/**
 * File signatures ("magic bytes").
 *
 * A declared Content-Type and a file extension are both attacker-controlled —
 * neither says anything about what the bytes actually are. Every upload is
 * therefore checked against the real signature, and a mismatch is rejected.
 */
const SIGNATURES = [
  { mime: 'image/jpeg', offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP — the format marker sits at offset 8.
  { mime: 'image/webp', offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
  // ISO-BMFF: 'ftyp' at offset 4, brand (heic/heif/mif1) follows.
  { mime: 'image/heic', offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

/** Identifies a buffer by its signature, or null if unrecognised. */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  for (const { mime, offset, bytes } of SIGNATURES) {
    const matches = bytes.every((byte, i) => buffer[offset + i] === byte);
    if (matches) return mime;
  }
  return null;
}

/**
 * Verifies the real content type and rejects anything that is not an image we
 * accept. HEIC and HEIF share a container, so they are treated as equivalent.
 */
function assertRealImage(buffer, declaredMime) {
  const detected = detectImageType(buffer);

  if (!detected) {
    throw ApiError.badRequest('That file is not a recognised image', {
      code: 'INVALID_IMAGE_CONTENT',
    });
  }

  const normalise = (m) => (m === 'image/heif' ? 'image/heic' : m);
  if (normalise(detected) !== normalise(declaredMime)) {
    throw ApiError.badRequest(
      `File contents do not match the declared type (${declaredMime})`,
      { code: 'MEDIA_TYPE_MISMATCH', details: { declared: declaredMime, detected } }
    );
  }

  return detected;
}

const imageFilter = (req, file, cb) => {
  if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
    return cb(
      ApiError.badRequest(`Unsupported image type: ${file.mimetype}`, {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        details: { allowed: [...ALLOWED_IMAGE_TYPES] },
      })
    );
  }
  cb(null, true);
};

/**
 * Express middleware running the signature check after multer has buffered
 * the file. Mount it directly after `uploadSingleImage`.
 */
function validateImageContent(req, res, next) {
  try {
    if (req.file?.buffer) {
      assertRealImage(req.file.buffer, req.file.mimetype);
    }
    for (const file of req.files || []) {
      assertRealImage(file.buffer, file.mimetype);
    }
    next();
  } catch (err) {
    next(err);
  }
}

const baseOptions = {
  storage: multer.memoryStorage(),
  limits: { fileSize: config.cloudinary.maxUploadBytes, files: 10 },
};

const uploadSingleImage = (field = 'file') =>
  multer({ ...baseOptions, fileFilter: imageFilter }).single(field);

const uploadMultipleImages = (field = 'files', maxCount = 10) =>
  multer({ ...baseOptions, fileFilter: imageFilter }).array(field, maxCount);

/** Spreadsheet import for bulk onboarding of an existing community register. */
const uploadSpreadsheet = (field = 'file') =>
  multer({
    ...baseOptions,
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const allowed = [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ];
      if (!allowed.includes(file.mimetype)) {
        return cb(ApiError.badRequest('Upload a .csv or .xlsx file'));
      }
      cb(null, true);
    },
  }).single(field);

/** Turns multer's own errors into the standard API error envelope. */
function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `File is larger than the ${config.cloudinary.maxUploadBytes / 1024 / 1024}MB limit`,
      LIMIT_FILE_COUNT: 'Too many files in one request',
      LIMIT_UNEXPECTED_FILE: `Unexpected file field: ${err.field}`,
    };
    return next(
      ApiError.badRequest(messages[err.code] || 'File upload failed', {
        code: err.code,
      })
    );
  }
  next(err);
}

module.exports = {
  uploadSingleImage,
  uploadMultipleImages,
  uploadSpreadsheet,
  handleUploadError,
  validateImageContent,
  detectImageType,
  assertRealImage,
  ALLOWED_IMAGE_TYPES,
};
