'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./user.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created, paginated } = require('../../utils/response');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { PERMISSIONS, ROLE_VALUES, USER_STATUS, LGA_CODES } = require('../../config/constants');

const router = express.Router();
router.use(authenticate);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const scope = z.object({
  lgas: z.array(z.enum(LGA_CODES)).max(18).optional(),
  communities: z.array(objectId).max(100).optional(),
});

const inviteUser = z.object({
  email: z.string().trim().email(),
  firstName: z.string().trim().min(2).max(60),
  lastName: z.string().trim().min(2).max(60),
  phone: z.string().trim().max(20).optional(),
  role: z.enum(ROLE_VALUES),
  scope: scope.optional(),
  cooperative: objectId.optional(),
  staffId: z.string().trim().max(40).optional(),
  designation: z.string().trim().max(80).optional(),
  /**
   * Optional. Omit it and the system generates a temporary password,
   * returned once in the response, with `mustChangePassword` set.
   */
  password: z.string().min(12).max(200).optional(),
});

const updateUser = z.object({
  firstName: z.string().trim().min(2).max(60).optional(),
  lastName: z.string().trim().min(2).max(60).optional(),
  phone: z.string().trim().max(20).optional(),
  role: z.enum(ROLE_VALUES).optional(),
  scope: scope.optional(),
  cooperative: objectId.optional(),
  staffId: z.string().trim().max(40).optional(),
  designation: z.string().trim().max(80).optional(),
});

const updateMe = z.object({
  firstName: z.string().trim().min(2).max(60).optional(),
  lastName: z.string().trim().min(2).max(60).optional(),
  phone: z.string().trim().max(20).optional(),
  designation: z.string().trim().max(80).optional(),
});

const listUsers = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  role: z.enum(ROLE_VALUES).optional(),
  status: z.enum(Object.values(USER_STATUS)).optional(),
  lga: z.enum(LGA_CODES).optional(),
  search: z.string().trim().max(120).optional(),
});

const idParam = z.object({ id: objectId });

// --- Self service ----------------------------------------------------------

/** The portal calls this immediately after sign-in to resolve role and scope. */
router.get(
  '/me',
  asyncHandler(async (req, res) => ok(res, await service.me(req.user)))
);

router.patch(
  '/me',
  validate({ body: updateMe }),
  asyncHandler(async (req, res) =>
    ok(res, await service.updateMe(req.user, req.body, { req }), { message: 'Profile updated' })
  )
);

// --- Administration --------------------------------------------------------

/**
 * Account administration is gated on the capability, not on rank. Rank alone
 * would admit any role that happens to sit high in the hierarchy — which is
 * how a Ministry Officer, who has no `user:manage` grant, could create
 * accounts.
 */
router.use(requirePermission(PERMISSIONS.USER_MANAGE));

router
  .route('/')
  .get(
    validate({ query: listUsers }),
    asyncHandler(async (req, res) => {
      const { items, pagination } = await service.list(req.query, req.user);
      return paginated(res, items, pagination);
    })
  )
  .post(
    validate({ body: inviteUser }),
    asyncHandler(async (req, res) =>
      created(res, await service.invite(req.body, req.user, { req }), {
        message:
          'Account created. If a temporary password was generated it is in this response and will not be shown again.',
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
    validate({ params: idParam, body: updateUser }),
    asyncHandler(async (req, res) =>
      ok(res, await service.update(req.params.id, req.body, req.user, { req }), {
        message: 'User updated',
      })
    )
  );

/** Approves an account that was auto-provisioned on first sign-in. */
router.post(
  '/:id/activate',
  validate({
    params: idParam,
    body: z.object({ role: z.enum(ROLE_VALUES).optional(), scope: scope.optional() }),
  }),
  asyncHandler(async (req, res) =>
    ok(res, await service.activate(req.params.id, req.body, req.user, { req }), {
      message: 'Account activated',
    })
  )
);

router.patch(
  '/:id/status',
  validate({
    params: idParam,
    body: z.object({
      status: z.enum(Object.values(USER_STATUS)),
      reason: z.string().trim().min(3).max(300),
    }),
  }),
  asyncHandler(async (req, res) =>
    ok(res, await service.changeStatus(req.params.id, req.body, req.user, { req }), {
      message: 'Account status updated',
    })
  )
);

module.exports = router;
