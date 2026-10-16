'use strict';

const express = require('express');
const { z } = require('zod');
const controller = require('./auth.controller');
const schemas = require('./auth.validation');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { createLimiter } = require('../../middleware/rateLimiter');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();

/**
 * Credential endpoints are rate limited far more tightly than ordinary
 * traffic, and keyed by IP because by definition the caller has no account
 * yet. These are the surfaces an attacker with a password list goes at.
 */
const loginLimiter = createLimiter({
  name: 'login',
  windowMs: 15 * 60_000,
  max: 10,
  keyBy: (req) => `ip:${req.ip}`,
});

const resetLimiter = createLimiter({
  name: 'reset',
  windowMs: 60 * 60_000,
  max: 5,
  keyBy: (req) => `ip:${req.ip}`,
});

// --- Public ----------------------------------------------------------------

/** Sign in with email and password. */
router.post('/login', loginLimiter, validate({ body: schemas.login }), controller.login);

/** Exchange a refresh token for a new pair. */
router.post('/refresh', validate({ body: schemas.refresh }), controller.refresh);

/** End the current session. Safe to call without a valid token. */
router.post('/logout', validate({ body: schemas.logout }), controller.logout);

/** Request a reset link. Always reports success, to avoid confirming accounts. */
router.post(
  '/forgot-password',
  resetLimiter,
  validate({ body: schemas.forgotPassword }),
  controller.forgotPassword
);

/** Complete a reset with a single-use token. */
router.post(
  '/reset-password',
  resetLimiter,
  validate({ body: schemas.resetPassword }),
  controller.resetPassword
);

// --- Authenticated ---------------------------------------------------------
router.use(authenticate);

/** The caller's own active sessions, so an unfamiliar one can be spotted. */
router.get('/sessions', controller.sessions);

/** Sign out everywhere. Takes no parameters; a body is rejected, not ignored. */
router.post('/logout-all', validate({ body: z.object({}).strict() }), controller.logoutAll);

/** Change your own password; every other session is ended. */
router.post(
  '/change-password',
  validate({ body: schemas.changePassword }),
  controller.changePassword
);

/** Administrative reset: issues a temporary password, shown once. */
router.post(
  '/users/:id/reset-password',
  requirePermission(PERMISSIONS.USER_MANAGE),
  validate({ params: schemas.idParam }),
  controller.adminResetPassword
);

module.exports = router;
