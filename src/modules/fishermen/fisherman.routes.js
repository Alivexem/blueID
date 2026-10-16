'use strict';

const express = require('express');
const controller = require('./fisherman.controller');
const schemas = require('./fisherman.validation');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { writeLimiter } = require('../../middleware/rateLimiter');
const {
  uploadSingleImage,
  validateImageContent,
  handleUploadError,
} = require('../../middleware/upload');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();

// Every route requires a verified identity. Capability is then checked per
// route, and row-level scope is enforced inside the service layer — a route
// cannot accidentally skip it.
router.use(authenticate);

/**
 * Duplicate probe before a record is submitted. Available to enumerators —
 * catching a duplicate at the point of capture is the whole point.
 */
router.post(
  '/check-duplicates',
  requirePermission(PERMISSIONS.FISHERMAN_CREATE),
  validate({ body: schemas.duplicateProbe }),
  controller.probeDuplicates
);

router
  .route('/')
  .get(
    requirePermission(PERMISSIONS.FISHERMAN_READ),
    validate({ query: schemas.listFishermen }),
    controller.list
  )
  .post(
    requirePermission(PERMISSIONS.FISHERMAN_CREATE),
    writeLimiter,
    validate({ body: schemas.createFisherman }),
    controller.create
  );

router.get(
  '/blue-id/:blueId',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  validate({ params: schemas.blueIdParam }),
  controller.getByBlueId
);

router
  .route('/:id')
  .get(
    requirePermission(PERMISSIONS.FISHERMAN_READ),
    validate({ params: schemas.idParam, query: schemas.getFisherman }),
    controller.getOne
  )
  .patch(
    requirePermission(PERMISSIONS.FISHERMAN_EDIT),
    validate({ params: schemas.idParam, body: schemas.updateFisherman }),
    controller.update
  )
  .delete(
    requirePermission(PERMISSIONS.FISHERMAN_DELETE),
    validate({ params: schemas.idParam, body: schemas.deleteFisherman }),
    controller.remove
  );

router.post(
  '/:id/photo',
  requirePermission(PERMISSIONS.FISHERMAN_EDIT),
  validate({ params: schemas.idParam }),
  uploadSingleImage('photo'),
  handleUploadError,
  // Checks the real file signature, not the declared content type.
  validateImageContent,
  controller.uploadPhoto
);

/** Verification issues the permanent Blue ID. */
router.post(
  '/:id/verify',
  requirePermission(PERMISSIONS.REGISTRATION_VERIFY),
  validate({ params: schemas.idParam, body: schemas.verifyFisherman }),
  controller.verify
);

router.patch(
  '/:id/status',
  requirePermission(PERMISSIONS.REGISTRATION_STATUS),
  validate({ params: schemas.idParam, body: schemas.changeStatus }),
  controller.changeStatus
);

router.get(
  '/:id/duplicates',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  validate({ params: schemas.idParam }),
  controller.checkDuplicates
);

router.post(
  '/:id/duplicates/resolve',
  requirePermission(PERMISSIONS.DUPLICATE_RESOLVE),
  validate({ params: schemas.idParam, body: schemas.resolveDuplicate }),
  controller.resolveDuplicate
);

/** QR code for the printed card — carries an opaque token, never the Blue ID. */
router.get(
  '/:id/qr',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  validate({ params: schemas.idParam, query: schemas.qrQuery }),
  controller.getQrCode
);

/**
 * Reissues a card, rotating the opaque token so the previous card stops
 * validating. Used when a card is lost or stolen.
 */
router.post(
  '/:id/reissue-card',
  requirePermission(PERMISSIONS.REGISTRATION_VERIFY),
  validate({ params: schemas.idParam, body: schemas.reissueCard }),
  controller.reissueCard
);

module.exports = router;
