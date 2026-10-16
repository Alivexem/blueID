'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./gis.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { LGA_CODES, PERMISSIONS } = require('../../config/constants');

const router = express.Router();
router.use(authenticate);
router.use(requirePermission(PERMISSIONS.DASHBOARD_VIEW));

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const mapQuery = z.object({
  lga: z.enum(LGA_CODES).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
});

const nearbyQuery = z.object({
  longitude: z.coerce.number().min(-180).max(180),
  latitude: z.coerce.number().min(-90).max(90),
  radiusKm: z.coerce.number().min(0.1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GeoJSON FeatureCollection of fishing communities. */
router.get(
  '/communities',
  validate({ query: mapQuery }),
  asyncHandler(async (req, res) => ok(res, await service.communityMap(req.query, req.user)))
);

router.get(
  '/communities/:id',
  validate({ params: z.object({ id: objectId }) }),
  asyncHandler(async (req, res) => ok(res, await service.communityDetail(req.params.id, req.user)))
);

/** Anonymised registration points for a density layer. */
router.get(
  '/registration-points',
  validate({ query: mapQuery }),
  asyncHandler(async (req, res) => ok(res, await service.registrationPoints(req.query, req.user)))
);

router.get(
  '/nearby',
  validate({ query: nearbyQuery }),
  asyncHandler(async (req, res) => ok(res, await service.nearby(req.query, req.user)))
);

module.exports = router;
