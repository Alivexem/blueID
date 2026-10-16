'use strict';

const express = require('express');
const controller = require('./programme.controller');
const schemas = require('./programme.validation');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requireMinRole, requirePermission } = require('../../middleware/authorize');
const {
  uploadSingleImage,
  validateImageContent,
  handleUploadError,
} = require('../../middleware/upload');
const { PERMISSIONS, ROLES } =
  require('../../config/constants');

const router = express.Router();
router.use(authenticate);

// --- Allocations -----------------------------------------------------------
// Declared before `/:id` so "allocations" is not read as a programme id.
router.get(
  '/allocations',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  validate({ query: schemas.listAllocations }),
  controller.listAllocations
);

router.post(
  '/allocations/:allocationId/deliver',
  requirePermission(PERMISSIONS.BENEFIT_DELIVER),
  validate({ params: schemas.allocationParam }),
  uploadSingleImage('acknowledgement'),
  handleUploadError,
  validateImageContent,
  validate({ body: schemas.markDelivered }),
  controller.markDelivered
);

router.patch(
  '/allocations/:allocationId/status',
  requirePermission(PERMISSIONS.BENEFIT_APPROVE),
  validate({ params: schemas.allocationParam, body: schemas.changeAllocationStatus }),
  controller.changeAllocationStatus
);

/** Benefit history for one Blue ID holder. */
router.get(
  '/beneficiaries/:fishermanId',
  requirePermission(PERMISSIONS.FISHERMAN_READ),
  validate({ params: schemas.fishermanParam }),
  controller.benefitHistory
);

// --- Programmes ------------------------------------------------------------
router
  .route('/')
  .get(
    requirePermission(PERMISSIONS.DASHBOARD_VIEW),
    validate({ query: schemas.listProgrammes }),
    controller.list
  )
  .post(
    requirePermission(PERMISSIONS.PROGRAMME_MANAGE),
    validate({ body: schemas.createProgramme }),
    controller.create
  );

router
  .route('/:id')
  .get(
    requirePermission(PERMISSIONS.DASHBOARD_VIEW),
    validate({ params: schemas.idParam }),
    controller.getOne
  )
  .patch(
    requirePermission(PERMISSIONS.PROGRAMME_MANAGE),
    validate({ params: schemas.idParam, body: schemas.updateProgramme }),
    controller.update
  )
  .delete(
    requirePermission(PERMISSIONS.PROGRAMME_MANAGE),
    requireMinRole(ROLES.STATE_ADMIN),
    validate({ params: schemas.idParam, body: schemas.removeProgramme }),
    controller.remove
  );

router.patch(
  '/:id/status',
  requirePermission(PERMISSIONS.PROGRAMME_MANAGE),
  validate({ params: schemas.idParam, body: schemas.changeProgrammeStatus }),
  controller.changeStatus
);

router.get(
  '/:id/eligible',
  requirePermission(PERMISSIONS.BENEFIT_ALLOCATE),
  validate({ params: schemas.idParam, query: schemas.listEligible }),
  controller.listEligible
);

router.get(
  '/:id/eligible/:fishermanId',
  requirePermission(PERMISSIONS.BENEFIT_ALLOCATE),
  validate({ params: schemas.eligibilityParams }),
  controller.checkEligibility
);

router.post(
  '/:id/allocations',
  requirePermission(PERMISSIONS.BENEFIT_ALLOCATE),
  validate({ params: schemas.idParam, body: schemas.createAllocation }),
  controller.allocate
);

module.exports = router;
