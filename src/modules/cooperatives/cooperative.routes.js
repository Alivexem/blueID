'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./cooperative.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created, accepted, paginated, noContent } = require('../../utils/response');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requireMinRole, requirePermission } = require('../../middleware/authorize');
const { writeLimiter } = require('../../middleware/rateLimiter');
const queue = require('../../services/queue.service');
const { PERMISSIONS, ROLES, LGA_CODES } =
  require('../../config/constants');

const router = express.Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const createCooperative = z.object({
  name: z.string().trim().min(3).max(160),
  registrationNumber: z.string().trim().max(40).optional(),
  lga: z.enum(LGA_CODES),
  community: objectId.optional(),
  communityName: z.string().trim().max(120).optional(),
  address: z.string().trim().max(240).optional(),
  registeredAt: z.coerce.date().optional(),
  officers: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(120),
        role: z.enum(['CHAIRMAN', 'SECRETARY', 'TREASURER', 'MEMBER', 'OTHER']).optional(),
        phone: z.string().trim().max(20).optional(),
        fisherman: objectId.optional(),
      })
    )
    .max(20)
    .optional(),
  contactPhone: z.string().trim().max(20).optional(),
  contactEmail: z.string().trim().email().optional(),
  bankDetails: z
    .object({
      bankName: z.string().trim().max(80).optional(),
      accountName: z.string().trim().max(120).optional(),
      accountNumberLast4: z.string().trim().regex(/^\d{4}$/).optional(),
    })
    .optional(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(1000).optional(),
});

const listCooperatives = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  lga: z.enum(LGA_CODES).optional(),
  community: objectId.optional(),
  isActive: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
});

const idParam = z.object({ id: objectId });
const memberParams = z.object({ id: objectId, fishermanId: objectId });

router
  .route('/')
  .get(
    validate({ query: listCooperatives }),
    asyncHandler(async (req, res) => {
      const { items, pagination } = await service.list(req.query, req.user);
      return paginated(res, items, pagination);
    })
  )
  .post(
    requirePermission(PERMISSIONS.COOPERATIVE_MANAGE),
    validate({ body: createCooperative }),
    asyncHandler(async (req, res) =>
      created(res, await service.create(req.body, req.user, { req }), {
        message: 'Cooperative registered',
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
    requirePermission(PERMISSIONS.COOPERATIVE_MANAGE),
    validate({ params: idParam, body: createCooperative.partial() }),
    asyncHandler(async (req, res) =>
      ok(res, await service.update(req.params.id, req.body, req.user, { req }), {
        message: 'Cooperative updated',
      })
    )
  )
  .delete(
    requirePermission(PERMISSIONS.COOPERATIVE_MANAGE),
    requireMinRole(ROLES.STATE_ADMIN),
    validate({ params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }),
    asyncHandler(async (req, res) => {
      await service.softDelete(req.params.id, req.user, { req, reason: req.body.reason });
      return noContent(res);
    })
  );

// --- Membership ------------------------------------------------------------

router.get(
  '/:id/members',
  validate({
    params: idParam,
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { items, pagination } = await service.listMembers(req.params.id, req.query, req.user);
    return paginated(res, items, pagination);
  })
);

router.post(
  '/:id/members',
  requirePermission(PERMISSIONS.COOPERATIVE_MANAGE),
  validate({
    params: idParam,
    body: z.object({
      fishermanId: objectId,
      membershipNumber: z.string().trim().max(40).optional(),
    }),
  }),
  asyncHandler(async (req, res) =>
    ok(res, await service.addMember(req.params.id, req.body, req.user, { req }), {
      message: 'Member added',
    })
  )
);

router.delete(
  '/:id/members/:fishermanId',
  requirePermission(PERMISSIONS.COOPERATIVE_MANAGE),
  validate({
    params: memberParams,
    body: z.object({ reason: z.string().trim().max(300).optional() }),
  }),
  asyncHandler(async (req, res) => {
    await service.removeMember(req.params.id, req.params.fishermanId, req.user, {
      req,
      reason: req.body?.reason,
    });
    return noContent(res);
  })
);

/** Queued for the same reason as the community recalculation above. */
router.post(
  '/recount-members',
  requirePermission(PERMISSIONS.COOPERATIVE_MANAGE),
  requireMinRole(ROLES.STATE_ADMIN),
  writeLimiter,
  // Takes no parameters; `.strict()` rejects a body rather than ignoring it,
  // so a caller is told their input had no effect instead of assuming it did.
  validate({ body: z.object({}).strict() }),
  asyncHandler(async (req, res) => {
    const job = await queue.enqueue(
      queue.JOB_TYPES.COOPERATIVE_RECOUNT,
      {},
      { dedupeKey: `cooperative-recount:${Math.floor(Date.now() / 60000)}`, req }
    );
    return accepted(res, { jobId: job?._id ?? null, queued: Boolean(job) }, {
      message: job ? 'Recount queued' : 'A recount is already queued',
    });
  })
);

module.exports = router;
