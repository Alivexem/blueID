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
const config = require('../../config');
const { FOLDERS } = require('../../config/cloudinary');
const { PERMISSIONS, AUDIT_ACTIONS } = require('../../config/constants');

const router = express.Router();

/**
 * Image delivery.
 *
 * Deliberately mounted BEFORE `authenticate`: the URL is handed to a browser
 * to put in an `<img src>`, and an image request carries no Authorization
 * header. The signature IS the authorisation, and it is only ever minted by
 * `/signed-url` below, after that caller has been checked against the record
 * the image belongs to. So the capability is delegated for a few minutes to
 * whoever holds the link, which is the same bargain the Cloudinary
 * `authenticated` URLs struck.
 *
 * Unsigned, expired or tampered requests get 404 rather than 403. A 403
 * would confirm that an image exists at that path, which is a membership
 * oracle over the register.
 */
router.get(
  '/file/*',
  asyncHandler(async (req, res) => {
    if (mediaService.driver !== 'local') throw ApiError.notFound('Not found');

    const requested = String(req.params[0] || '');
    const publicId = requested.replace(/\.(jpg|jpeg)$/i, '');

    const ok = mediaService.verifySignature(publicId, req.query.e, req.query.s);
    if (!ok) throw ApiError.notFound('Not found');

    const storage = require('../../services/storage');

    let absolute;
    try {
      absolute = storage.absolutePathFor(publicId);
    } catch {
      throw ApiError.notFound('Not found');
    }

    if (!(await storage.exists(publicId))) throw ApiError.notFound('Not found');

    const remaining = Math.max(0, Number(req.query.e) - Math.floor(Date.now() / 1000));
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', `private, max-age=${Math.min(300, remaining)}`);
    res.set('X-Content-Type-Options', 'nosniff');

    /**
     * With nginx in front, hand the file off and let it do the sending: the
     * bytes never enter the event loop, which matters when a day of field
     * photographs is being rendered in a list view.
     */
    if (config.media.xAccelPrefix) {
      res.set('X-Accel-Redirect', `${config.media.xAccelPrefix}/${publicId}.jpg`);
      return res.end();
    }

    return res.sendFile(absolute);
  })
);

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
