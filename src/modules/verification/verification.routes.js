'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./verification.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { validate } = require('../../middleware/validate');
const { optionalAuthenticate, serviceAuth } = require('../../middleware/authenticate');
const { verificationLimiter } = require('../../middleware/rateLimiter');

const router = express.Router();

/**
 * Verification endpoints.
 *
 * These are reachable without a user session, because the realistic scenario
 * is an official scanning a card at a landing site on a device that is not
 * signed in. Two things keep that safe:
 *
 *   - the unauthenticated response carries identity and status only;
 *   - the endpoint is rate limited per IP, so the register cannot be walked by
 *     enumerating Blue ID numbers.
 *
 * An authenticated officer gets the full operational view (`?detailed=true`).
 */

const blueIdParam = z.object({
  blueId: z.string().trim().toUpperCase().min(6).max(40),
});

const verifyQuery = z.object({
  detailed: z.coerce.boolean().optional(),
});

const scanBody = z.object({
  payload: z.string().trim().min(6).max(500),
  detailed: z.coerce.boolean().optional(),
});

router.get(
  '/:blueId',
  verificationLimiter,
  optionalAuthenticate,
  validate({ params: blueIdParam, query: verifyQuery }),
  asyncHandler(async (req, res) => {
    const result = await service.verifyBlueId(req.params.blueId, {
      actor: req.user,
      // Detail is only ever released to a signed-in officer.
      detailed: Boolean(req.query.detailed && req.user),
      req,
    });
    return ok(res, result);
  })
);

/** Scanned QR payload — signature is validated before the record is read. */
router.post(
  '/scan',
  verificationLimiter,
  optionalAuthenticate,
  validate({ body: scanBody }),
  asyncHandler(async (req, res) => {
    const result = await service.verifyScan(req.body.payload, {
      actor: req.user,
      detailed: Boolean(req.body.detailed && req.user),
      req,
    });
    return ok(res, result);
  })
);

/**
 * One-line status for an SMS/USSD gateway (§4). Served to trusted
 * machine callers only, via the service API key.
 */
router.get(
  '/:blueId/status-line',
  serviceAuth,
  validate({ params: blueIdParam }),
  asyncHandler(async (req, res) => ok(res, await service.statusLine(req.params.blueId)))
);

module.exports = router;
