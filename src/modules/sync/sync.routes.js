'use strict';

const express = require('express');
const controller = require('./sync.controller');
const schemas = require('./sync.validation');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { syncLimiter } = require('../../middleware/rateLimiter');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();

router.use(authenticate);

/** Cheap connectivity probe — deliberately outside the sync rate limit. */
router.get('/status', controller.status);

/** Reference data for a field trip: communities, programmes, cooperatives. */
router.get('/bootstrap', validate({ query: schemas.bootstrapQuery }), controller.bootstrap);

// --- The two sync verbs ----------------------------------------------------
// Capability is enforced here. `sync:submit` was declared and granted but
// never checked, so any authenticated user — including a cooperative officer
// who deliberately holds no such grant — could submit registrations.
router.post(
  '/push',
  requirePermission(PERMISSIONS.SYNC_SUBMIT),
  syncLimiter,
  validate({ body: schemas.pushBatch }),
  controller.push
);

router.get(
  '/pull',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  syncLimiter,
  validate({ query: schemas.pullChanges }),
  controller.pull
);

// --- Device administration -------------------------------------------------
router
  .route('/devices')
  .get(
    requirePermission(PERMISSIONS.DEVICE_MANAGE),
    validate({ query: schemas.listDevices }),
    controller.listDevices
  )
  .post(
    requirePermission(PERMISSIONS.DEVICE_MANAGE),
    validate({ body: schemas.registerDevice }),
    controller.registerDevice
  );

router.post(
  '/devices/:id/revoke',
  requirePermission(PERMISSIONS.DEVICE_MANAGE),
  validate({ params: schemas.idParam, body: schemas.revokeDevice }),
  controller.revokeDevice
);

// --- Batch monitoring ------------------------------------------------------
router.get(
  '/batches',
  requirePermission(PERMISSIONS.DEVICE_MANAGE),
  validate({ query: schemas.listBatches }),
  controller.listBatches
);

router.get(
  '/batches/:id',
  requirePermission(PERMISSIONS.DEVICE_MANAGE),
  validate({ params: schemas.idParam }),
  controller.getBatch
);

/**
 * The raw payloads of records this batch could not accept.
 *
 * These were retained but unreachable — stored `select: false` with no route
 * that selected them — so the promise that no field data is lost held in the
 * database and not in practice. An operator can now retrieve a rejected
 * capture, correct it and re-submit it. The read is audited, because it
 * returns personal data that never passed validation.
 */
router.get(
  '/batches/:id/rejected',
  requirePermission(PERMISSIONS.DEVICE_MANAGE),
  validate({ params: schemas.idParam }),
  controller.getRejectedRecords
);

module.exports = router;
