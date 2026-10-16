'use strict';

const express = require('express');
const { handlersFor, listForOwner } = require('./asset.controller');
const schemas = require('./asset.validation');
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

/**
 * Builds a CRUD router for one asset kind. Boats, engines and equipment differ
 * only in their create/update schemas, so the route shape is generated rather
 * than written out three times.
 */
function assetRouter(kind, { createSchema, updateSchema }) {
  const router = express.Router();
  const handlers = handlersFor(kind);

  router.use(authenticate);

  router
    .route('/')
    .get(
      requirePermission(PERMISSIONS.FISHERMAN_READ),
      validate({ query: schemas.listAssets }),
      handlers.list
    )
    .post(
      requirePermission(PERMISSIONS.ASSET_MANAGE),
      writeLimiter,
      validate({ body: createSchema }),
      handlers.create
    );

  router
    .route('/:id')
    .get(
      requirePermission(PERMISSIONS.FISHERMAN_READ),
      validate({ params: schemas.idParam }),
      handlers.getOne
    )
    .patch(
      requirePermission(PERMISSIONS.ASSET_MANAGE),
      validate({ params: schemas.idParam, body: updateSchema }),
      handlers.update
    )
    .delete(
      requirePermission(PERMISSIONS.ASSET_MANAGE),
      validate({ params: schemas.idParam, body: schemas.removeAsset }),
      handlers.remove
    );

  router.post(
    '/:id/photo',
    validate({ params: schemas.idParam }),
    requirePermission(PERMISSIONS.ASSET_MANAGE),
    uploadSingleImage('photo'),
    handleUploadError,
    validateImageContent,
    handlers.uploadPhoto
  );

  router.post(
    '/:id/transfer',
    requirePermission(PERMISSIONS.ASSET_TRANSFER),
    validate({ params: schemas.idParam, body: schemas.transferAsset }),
    handlers.transfer
  );

  return router;
}

const boatRoutes = assetRouter('BOAT', {
  createSchema: schemas.createBoat,
  updateSchema: schemas.updateBoat,
});

const engineRoutes = assetRouter('ENGINE', {
  createSchema: schemas.createEngine,
  updateSchema: schemas.updateEngine,
});

const equipmentRoutes = assetRouter('EQUIPMENT', {
  createSchema: schemas.createEquipment,
  updateSchema: schemas.updateEquipment,
});

/** GET /assets/owner/:ownerId — every asset belonging to one Blue ID. */
const ownerRoutes = express.Router();
ownerRoutes.use(authenticate);
ownerRoutes.get(
  '/owner/:ownerId',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  validate({ params: schemas.ownerParam }),
  listForOwner
);

module.exports = { boatRoutes, engineRoutes, equipmentRoutes, ownerRoutes };
