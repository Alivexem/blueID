'use strict';

const express = require('express');
const database = require('../../config/database');
const redis = require('../../config/redis');
const cloudinary = require('../../config/cloudinary');
const mediaService = require('../../services/media.service');
const config = require('../../config');
const logger = require('../../config/logger');
const asyncHandler = require('../../utils/asyncHandler');
const { constantTimeEquals } = require('../../middleware/authenticate');

const router = express.Router();

const startedAt = Date.now();

/**
 * Health endpoints.
 *
 * `/live` answers "is the process up" and must never touch a dependency — a
 * slow database would otherwise cause an orchestrator to restart a server
 * that is working perfectly well.
 *
 * `/ready` answers "can this instance serve traffic". It checks dependencies,
 * but WHAT IT SAYS depends on who is asking.
 *
 * A probe needs a status code, not a diagnosis. The detailed body previously
 * went to anyone: build version, deployment environment, which integrations
 * are configured, raw driver error text, internal collection names, and —
 * when indexes were missing — the names of the uniqueness constraints that
 * were absent. That is a map of the system and its current weaknesses,
 * served unauthenticated. Detail is now released only to a caller holding the
 * internal probe key, and everyone else gets up/down.
 */

/** Liveness: no dependency calls, by design. */
router.get('/live', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: Math.floor((Date.now() - startedAt) / 1000) });
});

/**
 * Readiness is reported as "not ready" during a graceful shutdown, before the
 * server stops accepting connections, so a load balancer drains this instance
 * instead of sending requests into a closing process.
 */
let acceptingTraffic = true;

function setAcceptingTraffic(value) {
  acceptingTraffic = value;
}

/** Only a caller holding the internal probe key sees the diagnosis. */
function maySeeDetail(req) {
  const key = req.get('x-probe-key');
  if (!config.app.probeKey || !key) return false;
  return constantTimeEquals(key, config.app.probeKey);
}

async function collectChecks() {
  const checks = {};

  try {
    checks.mongodb = { status: 'ok', latencyMs: await database.ping() };
  } catch (err) {
    checks.mongodb = { status: 'error', error: err.message };
  }

  try {
    const latencyMs = await redis.ping();
    // In production the in-memory fallback is a failure, not a degradation:
    // rate limits stop being shared and the sync lock stops being distributed.
    const onFallback = redis.isMemoryFallback();
    checks.redis = {
      status: onFallback ? (config.isProduction ? 'error' : 'degraded') : 'ok',
      latencyMs,
      ...(onFallback
        ? { note: 'in-memory fallback — rate limits are per-process and not shared' }
        : {}),
    };
  } catch (err) {
    checks.redis = { status: 'error', error: err.message };
  }

  /**
   * With the local driver this writes a probe file. A volume that is
   * unmounted, full or read-only is otherwise discovered on the first upload
   * of the working day, by an enumerator in a village, which is the worst
   * possible moment and place to find out.
   */
  try {
    const media = await mediaService.healthCheck();
    checks.media = media.ok
      ? { status: 'ok', driver: mediaService.driver }
      : { status: 'error', driver: mediaService.driver, error: media.error };
  } catch (err) {
    checks.media = { status: 'error', driver: mediaService.driver, error: err.message };
  }

  if (config.media.driver === 'cloudinary') {
    checks.cloudinary = { status: cloudinary.isEnabled() ? 'ok' : 'not configured' };
  }
  checks.email = { status: config.brevo.enabled ? 'ok' : 'not configured' };

  /**
   * Critical indexes. `autoIndex` is off in production, so a deploy that
   * skipped `npm run db:indexes` leaves the database without the constraints
   * that prevent duplicate Blue IDs and duplicate benefits — and nothing else
   * would report it, because the failure mode is silently accepting bad data.
   */
  if (checks.mongodb.status === 'ok') {
    try {
      const missing = await require('../../scripts/syncIndexes').check();
      checks.indexes = missing.length
        ? {
            status: 'error',
            missing: missing.map((m) => `${m.model}.${m.name}`),
            note: 'uniqueness is NOT enforced — run: npm run db:indexes',
          }
        : { status: 'ok' };
    } catch (err) {
      checks.indexes = { status: 'unknown', error: err.message };
    }
  }

  // Queue depth and the age of the oldest due job: a growing backlog, or a
  // job long overdue, means workers are stuck.
  try {
    const queueStats = await require('../../services/queue.service').stats();
    const stalled = queueStats.oldestPendingAgeMs > 15 * 60 * 1000;
    checks.jobs = {
      status: !config.worker.enabled ? 'disabled' : stalled ? 'degraded' : 'ok',
      due: queueStats.due,
      dead: queueStats.byStatus?.DEAD || 0,
      oldestPendingAgeMs: queueStats.oldestPendingAgeMs,
      ...(stalled ? { note: 'oldest due job is over 15 minutes old' } : {}),
    };
  } catch (err) {
    checks.jobs = { status: 'error', error: err.message };
  }

  return checks;
}

const readiness = asyncHandler(async (req, res) => {
  if (!acceptingTraffic) {
    // Shutting down: fail readiness immediately so traffic is drained away.
    return res.status(503).json({ status: 'draining' });
  }

  const checks = await collectChecks();

  /**
   * Readiness fails on an unreachable database, on missing critical indexes,
   * and on a Redis failure — serving traffic without uniqueness constraints
   * means accepting duplicates into a permanent government register, which is
   * worse than serving nothing.
   */
  const healthy =
    checks.mongodb.status === 'ok' &&
    checks.indexes?.status !== 'error' &&
    checks.redis.status !== 'error' &&
    // A register that cannot store a photograph cannot complete a
    // registration, so this instance should not be taking traffic.
    checks.media?.status !== 'error';

  if (!healthy) {
    // Always logged in full, so the detail an operator needs is in the log
    // rather than in an unauthenticated HTTP response.
    logger.error({ checks }, 'Readiness check failed');
  }

  if (!maySeeDetail(req)) {
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'unavailable' });
  }

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'unavailable',
    service: 'blueid-api',
    version: require('../../../package.json').version,
    environment: config.env,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    checks,
    timestamp: new Date().toISOString(),
  });
});

router.get('/ready', readiness);
/** Default health route, same as readiness. */
router.get('/', readiness);

module.exports = router;
module.exports.setAcceptingTraffic = setAcceptingTraffic;
