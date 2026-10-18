'use strict';

const express = require('express');
const { z } = require('zod');
const mediaService = require('../../services/media.service');
const auditService = require('../../services/audit.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const ApiError = require('../../utils/ApiError');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission, assertCanAccessRecord } = require('../../middleware/authorize');
const {
  uploadSingleImage,
  validateImageContent,
  handleUploadError,
} = require('../../middleware/upload');
const { writeLimiter } = require('../../middleware/rateLimiter');
const { FOLDERS } = require('../../config/cloudinary');
const { PERMISSIONS, AUDIT_ACTIONS } = require('../../config/constants');

const router = express.Router();

router.use(authenticate);

/**
 * Media endpoints.
 *
 * The governing rule here is that a caller never names a Cloudinary asset
 * directly. They name a RECORD, the server authorises that record, and the
 * server supplies the asset id from it.
 *
 * This replaces an earlier design that accepted an arbitrary `publicId`:
 * because Cloudinary ids are predictable (`blueid/fishermen/<LGA>/<BlueID>`),
 * any authenticated user could mint a signed URL for a photograph in an LGA
 * they have no access to, and could aim an upload at an existing id to
 * overwrite someone else's passport photograph. Both were object-level
 * authorization failures wearing a storage-API costume.
 */

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier');

/** Record kinds a caller may reference, and how to load and authorise each. */
const SUBJECTS = {
  FISHERMAN: {
    model: () => require('../fishermen/fisherman.model'),
    select: 'photo lga community registeredBy',
    folder: (doc) => FOLDERS.fishermanPhoto(doc.lga),
    scope: { cooperativeField: 'cooperative.id' },
  },
  BOAT: {
    model: () => require('../assets/boat.model'),
    select: 'photo lga community registeredBy blueId',
    folder: (doc) => FOLDERS.boatPhoto(doc.lga),
    scope: { cooperativeField: null },
  },
  ENGINE: {
    model: () => require('../assets/engine.model'),
    select: 'photo lga registeredBy blueId',
    folder: (doc) => FOLDERS.boatPhoto(doc.lga),
    scope: { cooperativeField: null, communityField: null },
  },
  EQUIPMENT: {
    model: () => require('../assets/equipment.model'),
    select: 'photo lga registeredBy blueId',
    folder: (doc) => FOLDERS.equipmentPhoto(doc.lga),
    scope: { cooperativeField: null, communityField: null },
  },
  ALLOCATION: {
    model: () => require('../programmes/allocation.model'),
    select: 'acknowledgement lga programmeCode blueId',
    folder: (doc) => FOLDERS.acknowledgement(doc.programmeCode || 'general'),
    scope: { cooperativeField: null, communityField: null, ownerField: null },
  },
};

/** Loads the referenced record and enforces object-level authorization. */
async function loadSubject(kind, id, actor) {
  const subject = SUBJECTS[kind];
  if (!subject) throw ApiError.badRequest(`Unsupported media subject: ${kind}`);

  const doc = await subject.model()
    .findOne({ _id: id, isDeleted: { $ne: true } })
    .select(subject.select)
    .lean();

  // Deliberately "not found" rather than "forbidden": confirming a record
  // exists but is out of scope is itself a disclosure.
  if (!doc) throw ApiError.notFound('Record not found');
  assertCanAccessRecord(actor, doc, subject.scope);

  return { doc, subject };
}

const subjectQuery = z.object({
  kind: z.enum(Object.keys(SUBJECTS)),
  id: objectId,
  expiresIn: z.coerce.number().int().min(60).max(3600).optional(),
});

/**
 * Mints a short-lived signed URL for a record's stored image.
 * The asset id comes from the record, never from the caller.
 */
router.get(
  '/signed-url',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  validate({ query: subjectQuery }),
  asyncHandler(async (req, res) => {
    const { doc } = await loadSubject(req.query.kind, req.query.id, req.user);

    const media = doc.photo || doc.acknowledgement;
    if (!media?.publicId) {
      throw ApiError.notFound('That record has no stored image');
    }

    const expiresIn = req.query.expiresIn || 600;
    const url = mediaService.signedUrl(media.publicId, { expiresInSeconds: expiresIn });

    await auditService.record({
      action: AUDIT_ACTIONS.VIEW_SENSITIVE,
      entity: { type: req.query.kind, id: doc._id, blueId: doc.blueId },
      lga: doc.lga,
      metadata: { field: 'photo', expiresIn },
      req,
    });

    return ok(res, { url, expiresIn });
  })
);

const signatureBody = z.object({
  kind: z.enum(Object.keys(SUBJECTS)),
  id: objectId,
});

/**
 * Credentials for a direct device → Cloudinary upload.
 *
 * The field app uses this so a device returning from a week offline can push
 * a day's photographs straight to Cloudinary, in parallel with its record
 * sync, without the API becoming the bottleneck.
 *
 * The target id is DERIVED from the authorised record, so an upload cannot be
 * aimed at another record's asset.
 */
router.post(
  '/upload-signature',
  requirePermission(PERMISSIONS.FISHERMAN_EDIT),
  writeLimiter,
  validate({ body: signatureBody }),
  asyncHandler(async (req, res) => {
    const { doc, subject } = await loadSubject(req.body.kind, req.body.id, req.user);

    const signature = mediaService.createUploadSignature({
      folder: subject.folder(doc),
      // Deterministic and server-chosen: the caller cannot redirect it.
      publicId: mediaService.deterministicPublicId(`${req.body.kind}:${doc._id}`),
      tags: [req.body.kind.toLowerCase(), doc.lga].filter(Boolean),
    });

    return ok(res, signature, {
      message: 'Upload directly to Cloudinary with these parameters',
    });
  })
);

/** Server-side upload, used by the web portal. */
router.post(
  '/upload',
  requirePermission(PERMISSIONS.FISHERMAN_EDIT),
  writeLimiter,
  uploadSingleImage('file'),
  handleUploadError,
  // Verifies the real file signature, not the declared content type.
  validateImageContent,
  validate({ body: signatureBody }),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('Attach an image in the `file` field');

    const { doc, subject } = await loadSubject(req.body.kind, req.body.id, req.user);

    const media =
      req.body.kind === 'ALLOCATION'
        ? await mediaService.uploadAcknowledgement(req.file.buffer, {
            programmeCode: doc.programmeCode,
            blueId: doc.blueId,
          })
        : req.body.kind === 'FISHERMAN'
          ? await mediaService.uploadFishermanPhoto(req.file.buffer, {
              lga: doc.lga,
              blueId: doc.blueId,
            })
          : await mediaService.uploadAssetPhoto(req.file.buffer, {
              kind: req.body.kind,
              lga: doc.lga,
              ownerBlueId: doc.blueId,
            });

    // The caller still attaches it through the owning module's own endpoint,
    // which is where the record write and its audit entry belong.
    return ok(res, media, { message: 'Upload complete', folder: subject.folder(doc) });
  })
);

module.exports = router;
