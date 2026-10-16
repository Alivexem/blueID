'use strict';

const express = require('express');
const { z } = require('zod');
const AuditLog = require('./audit.model');
const auditService = require('../../services/audit.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, paginated } = require('../../utils/response');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission, isStateWide, scopedLgas } = require('../../middleware/authorize');
const { paginate, resolvePagination } = require('../../utils/pagination');
const { PERMISSIONS, AUDIT_ACTIONS } =
  require('../../config/constants');

const router = express.Router();

router.use(authenticate);
// The audit trail records who looked at what; reading it is itself privileged.
router.use(requirePermission(PERMISSIONS.AUDIT_READ));

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const listAudit = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  action: z.enum(Object.values(AUDIT_ACTIONS)).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: objectId.optional(),
  blueId: z.string().trim().max(40).optional(),
  userId: objectId.optional(),
  outcome: z.enum(['SUCCESS', 'FAILURE']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

router.get(
  '/',
  validate({ query: listAudit }),
  asyncHandler(async (req, res) => {
    const pagination = resolvePagination(req.query);
    const filter = {};

    if (req.query.action) filter.action = req.query.action;
    if (req.query.entityType) filter['entity.type'] = req.query.entityType;
    if (req.query.entityId) filter['entity.id'] = req.query.entityId;
    if (req.query.blueId) filter['entity.blueId'] = req.query.blueId.toUpperCase();
    if (req.query.userId) filter['actor.user'] = req.query.userId;
    if (req.query.outcome) filter.outcome = req.query.outcome;
    if (req.query.from || req.query.to) {
      filter.createdAt = {};
      if (req.query.from) filter.createdAt.$gte = req.query.from;
      if (req.query.to) filter.createdAt.$lte = req.query.to;
    }

    // An LGA administrator sees their own LGAs' activity, plus entries that
    // carry no LGA (system-level actions) only if they are state-wide.
    if (!isStateWide(req.user)) {
      filter.lga = { $in: scopedLgas(req.user) };
    }

    const { items, pagination: meta } = await paginate(AuditLog, filter, pagination, {
      sort: { createdAt: -1 },
      populate: [{ path: 'actor.user', select: 'firstName lastName email role' }],
    });

    return paginated(res, items, meta);
  })
);

/** Full history of one record — the "who changed this" view. */
router.get(
  '/:entityType/:entityId',
  validate({
    params: z.object({ entityType: z.string().trim().max(40), entityId: objectId }),
    query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }),
  }),
  asyncHandler(async (req, res) => {
    const history = await auditService.historyFor(req.params.entityType, req.params.entityId, {
      limit: req.query.limit || 50,
    });
    return ok(res, history);
  })
);

module.exports = router;
