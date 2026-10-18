'use strict';

const express = require('express');
const { z } = require('zod');
const controller = require('./auth.controller');
const schemas = require('./auth.validation');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { createLimiter } = require('../../middleware/rateLimiter');
const config = require('../../config');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();

/**
 * Credential endpoints are rate limited far more tightly than ordinary
 * traffic. These are the surfaces an attacker with a password list goes at.
 *
 * TWO LIMITS, BECAUSE ONE KEY CANNOT DO BOTH JOBS.
 *
 * Keyed on the IP alone, a whole LGA office shares one budget: they sit
 * behind a single NAT, so five officers arriving at eight o'clock with a
 * couple of mistyped passwords between them would lock out the building,
 * and it would be reported as the system being down.
 *
 * Keyed on the address alone, an attacker rotates addresses and is never
 * limited at all.
 *
 * So: a tight limit per address-from-this-IP, which is what stops someone
 * guessing one account, and a looser ceiling on the IP as a whole, which is
 * what stops one address working through a list. The per-account lockout in
 * auth.service is the third layer and the one that actually protects a
 * specific account — it follows the account wherever the attempts come from.
 */
const loginLimiter = createLimiter({
  name: 'login',
  windowMs: 15 * 60_000,
  max: config.auth.loginAttemptsPerAccount,
  keyBy: (req) => {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();
    // No address yet (a malformed body) falls back to the IP, so the
    // request is still counted rather than slipping past unlimited.
    return email ? `login:${req.ip}:${email}` : `login:${req.ip}`;
  },
});

/** The ceiling for one address across every account it tries. */
const loginIpLimiter = createLimiter({
  name: 'login-ip',
  windowMs: 15 * 60_000,
  max: config.auth.loginAttemptsPerIp,
  keyBy: (req) => `login-ip:${req.ip}`,
});

const resetLimiter = createLimiter({
  name: 'reset',
  windowMs: 60 * 60_000,
  max: 5,
  keyBy: (req) => `ip:${req.ip}`,
});

// --- Public ----------------------------------------------------------------

/** Sign in with email and password. */
router.post(
  '/login',
  loginIpLimiter,
  loginLimiter,
  validate({ body: schemas.login }),
  controller.login
);

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
