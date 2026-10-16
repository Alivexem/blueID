'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./community.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created, accepted, paginated, noContent } = require('../../utils/response');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requireMinRole, requirePermission } = require('../../middleware/authorize');
const { writeLimiter } = require('../../middleware/rateLimiter');
const queue = require('../../services/queue.service');
const { PERMISSIONS, ROLES, LGA_CODES, COMMUNITY_TYPES, FACILITY_KEYS } =
  require('../../config/constants');

const router = express.Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const facilityKey = z.enum(FACILITY_KEYS);

const point = z
  .object({
    type: z.literal('Point').optional(),
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  })
  .optional();

const facilities = z
  .object(Object.fromEntries(FACILITY_KEYS.map((k) => [k, z.boolean().optional()])))
  .optional();

const createCommunity = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().max(24).optional(),
  lga: z.enum(LGA_CODES),
  ward: z.string().trim().max(80).optional(),
  type: z.enum(Object.values(COMMUNITY_TYPES)).optional(),
  location: point,
  landingSites: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        location: point,
        hasJetty: z.boolean().optional(),
        hasColdStorage: z.boolean().optional(),
        condition: z.enum(['GOOD', 'FAIR', 'POOR', 'NONE']).optional(),
        notes: z.string().trim().max(300).optional(),
      })
    )
    .max(30)
    .optional(),
  facilities,
  accessibility: z
    .object({
      roadAccess: z.boolean().optional(),
      boatOnlyAccess: z.boolean().optional(),
      mobileNetwork: z.enum(['NONE', 'POOR', 'FAIR', 'GOOD']).optional(),
      electricity: z.boolean().optional(),
    })
    .optional(),
  estimatedPopulation: z.coerce.number().int().min(0).optional(),
  estimatedFishermen: z.coerce.number().int().min(0).optional(),
  contactPerson: z
    .object({
      name: z.string().trim().max(120).optional(),
      phone: z.string().trim().max(20).optional(),
      title: z.string().trim().max(80).optional(),
    })
    .optional(),
  developmentNeeds: z.array(z.string().trim().max(120)).max(20).optional(),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
});

const listCommunities = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  lga: z.enum(LGA_CODES).optional(),
  type: z.enum(Object.values(COMMUNITY_TYPES)).optional(),
  isActive: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
  /** `lacking=coldStorage` powers the infrastructure-gap views. */
  lacking: facilityKey.optional(),
  has: facilityKey.optional(),
});

const idParam = z.object({ id: objectId });

/** Lightweight list for dropdowns and offline caching. */
router.get(
  '/reference',
  asyncHandler(async (req, res) => ok(res, await service.reference(req.user)))
);

router
  .route('/')
  .get(
    validate({ query: listCommunities }),
    asyncHandler(async (req, res) => {
      const { items, pagination } = await service.list(req.query, req.user);
      return paginated(res, items, pagination);
    })
  )
  .post(
    requirePermission(PERMISSIONS.COMMUNITY_MANAGE),
    validate({ body: createCommunity }),
    asyncHandler(async (req, res) =>
      created(res, await service.create(req.body, req.user, { req }), {
        message: 'Community created',
      })
    )
  );

router
  .route('/:id')
  .get(
    validate({ params: idParam }),
    asyncHandler(async (req, res) => ok(res, await service.getById(req.params.id, req.user)))
  )
  .patch(
    requirePermission(PERMISSIONS.COMMUNITY_MANAGE),
    validate({ params: idParam, body: createCommunity.partial() }),
    asyncHandler(async (req, res) =>
      ok(res, await service.update(req.params.id, req.body, req.user, { req }), {
        message: 'Community updated',
      })
    )
  )
  .delete(
    // Rank keeps this away from LGA administrators; the permission keeps it
    // away from oversight-only roles that outrank them.
    requirePermission(PERMISSIONS.COMMUNITY_MANAGE),
    requireMinRole(ROLES.STATE_ADMIN),
    validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }),
    asyncHandler(async (req, res) => {
      await service.softDelete(req.params.id, req.user, { req, reason: req.body.reason });
      return noContent(res);
    })
  );

/**
 * Refreshes denormalised per-community counters.
 *
 * Queued rather than run inline: it aggregates across every community in the
 * scope, so holding an HTTP connection open for it ties up a worker and a
 * database connection for an unbounded time, and a handful of concurrent
 * calls could saturate the pool. The dedupe key collapses repeat requests
 * within the same minute into one job.
 */
router.post(
  '/recalculate-stats',
  requirePermission(PERMISSIONS.COMMUNITY_MANAGE),
  requireMinRole(ROLES.STATE_ADMIN),
  writeLimiter,
  validate({ body: z.object({ lga: z.enum(LGA_CODES).optional() }) }),
  asyncHandler(async (req, res) => {
    const job = await queue.enqueue(
      queue.JOB_TYPES.COMMUNITY_STATS_RECALCULATE,
      { lga: req.body.lga },
      {
        dedupeKey: `community-stats:${req.body.lga || 'all'}:${Math.floor(Date.now() / 60000)}`,
        req,
      }
    );
    return accepted(res, { jobId: job?._id ?? null, queued: Boolean(job) }, {
      message: job ? 'Recalculation queued' : 'A recalculation is already queued',
    });
  })
);

module.exports = router;
