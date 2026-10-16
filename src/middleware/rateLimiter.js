'use strict';

const rateLimit = require('express-rate-limit');
const { client, isEnabled } = require('../config/redis');
const config = require('../config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

/**
 * Distributed rate limiting.
 *
 * Two problems with the obvious implementation, both fixed here:
 *
 * 1. PER-PROCESS COUNTERS. The default memory store means every API instance
 *    enforces its own budget, so N instances multiply the real limit by N.
 *    Counters now live in Redis, shared across the fleet.
 *
 * 2. KEYED BY IP ONLY. The limiter runs before authentication, so `req.user`
 *    was always undefined and every officer in an LGA office behind one NAT
 *    shared a single budget. `attachPrincipal` (see authenticate.js) now
 *    cryptographically verifies the token ahead of the limiter and exposes
 *    `req.principalId`, so limits are per-account where an account is known
 *    and per-IP otherwise. The id comes from a verified signature, so it
 *    cannot be spoofed to escape a limit.
 *
 * Redis failures fail OPEN: a cache outage must not lock every field officer
 * out of the register.
 */

/**
 * Fixed-window counter in Redis, evaluated with INCR + EXPIRE.
 *
 * A sliding window would be more precise, but this is one round trip, is
 * atomic without a Lua script, and the imprecision at a window boundary is
 * irrelevant for abuse protection at these thresholds.
 */
/**
 * Establishes the counter WITH its expiry, then increments it.
 *
 * The obvious `INCR` followed by a conditional `EXPIRE` is not safe: if the
 * second call never lands — a network blip, a process killed between the two
 * REST round trips — the key exists with no TTL and never expires. Once such
 * an orphaned counter passes the threshold, that principal is throttled
 * permanently, with no self-recovery. For the failed-authentication counter
 * that means locking out an entire office behind one NAT, forever.
 *
 * `SET key 0 EX ttl NX` is atomic and idempotent: it creates the key with its
 * lifetime in a single operation, or does nothing if it already exists. The
 * subsequent INCR can then fail harmlessly — the worst case is an undercount
 * for one request, never an immortal key.
 */
async function incrementWithTtl(redisKey, ttlSeconds) {
  await client.set(redisKey, 0, { ex: ttlSeconds, nx: true });
  return client.incr(redisKey);
}

/**
 * Per-process fallback used only while Redis is unreachable.
 *
 * Failing fully open means a Redis outage removes all abuse protection from
 * the API at once. This keeps a local budget so protection degrades — each
 * instance enforces its own limit — instead of disappearing. Entries are
 * bounded and swept, so it cannot grow without limit during a long outage.
 */
const LOCAL_FALLBACK_LIMIT = 10_000;
const localCounters = new Map();

function localIncrement(mapKey, windowMs) {
  const now = Date.now();
  const entry = localCounters.get(mapKey);

  if (!entry || entry.expiresAt <= now) {
    if (localCounters.size >= LOCAL_FALLBACK_LIMIT) {
      // Drop whatever is oldest; this is a degraded mode, not a ledger.
      localCounters.delete(localCounters.keys().next().value);
    }
    localCounters.set(mapKey, { hits: 1, expiresAt: now + windowMs });
    return 1;
  }

  entry.hits += 1;
  return entry.hits;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of localCounters) {
    if (entry.expiresAt <= now) localCounters.delete(k);
  }
}, 60_000).unref();

function redisStore(prefix) {
  return {
    async increment(key, windowMs) {
      const bucket = Math.floor(Date.now() / windowMs);
      const redisKey = `${config.redis.prefix}:rl:${prefix}:${key}:${bucket}`;
      const ttlSeconds = Math.ceil(windowMs / 1000) + 1;

      try {
        const hits = await incrementWithTtl(redisKey, ttlSeconds);
        return { hits, resetTime: new Date((bucket + 1) * windowMs), degraded: false };
      } catch (err) {
        // Degrade to a per-instance budget rather than to no limit at all.
        const hits = localIncrement(redisKey, windowMs);
        logger.warn({ err, prefix }, 'Rate limiter falling back to per-process counters');
        return { hits, resetTime: new Date((bucket + 1) * windowMs), degraded: true };
      }
    },
  };
}

/**
 * Identifies the caller: verified account first, then device, then IP.
 * IPv6 addresses are normalised to a /64 prefix, because a single subscriber
 * is routinely handed an entire /64 and could otherwise rotate addresses to
 * evade the limit.
 */
function identify(req) {
  if (req.principalId) return `u:${req.principalId}`;
  if (req.user?.id) return `u:${req.user.id}`;

  const deviceId = req.get('x-device-id');
  if (deviceId) return `d:${deviceId.slice(0, 64)}`;

  return `ip:${normaliseIp(req.ip)}`;
}

function normaliseIp(ip = '') {
  if (!ip) return 'unknown';
  if (ip.includes(':')) {
    // Collapse to the routing prefix.
    const segments = ip.split(':').slice(0, 4);
    return `${segments.join(':')}::/64`;
  }
  return ip;
}

/**
 * Builds a limiter. Uses Redis when configured; otherwise falls back to
 * express-rate-limit's in-process store, which is correct for a single
 * instance and is all a development machine needs.
 */
function createLimiter({ name, windowMs, max, keyBy = identify, skip }) {
  if (!isEnabled()) {
    return rateLimit({
      windowMs,
      max,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator: keyBy,
      skip,
      handler: rejection,
      // `identify` already normalises IPv6 to a /64, so the library's own
      // IP-handling check would only warn about something we handle.
      validate: { ip: false },
    });
  }

  const store = redisStore(name);

  return async function limiter(req, res, next) {
    if (skip?.(req)) return next();

    const key = keyBy(req);

    try {
      const { hits, resetTime, degraded } = await store.increment(key, windowMs);
      const remaining = Math.max(0, max - hits);

      res.setHeader('RateLimit-Policy', `${max};w=${Math.ceil(windowMs / 1000)}`);
      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(Math.ceil((resetTime.getTime() - Date.now()) / 1000)));
      if (degraded) res.setHeader('RateLimit-Degraded', '1');

      if (hits > max) {
        res.setHeader('Retry-After', String(Math.ceil((resetTime.getTime() - Date.now()) / 1000)));
        logger.warn({ key, name, hits, max, degraded }, 'Rate limit exceeded');
        return next(
          ApiError.tooMany('Too many requests — please slow down and try again shortly')
        );
      }

      return next();
    } catch (err) {
      /**
       * The store already degrades to per-process counters, so reaching here
       * means something unexpected broke. Allow the request: denying every
       * field officer because the limiter itself is faulty is the worse
       * outcome for a register they depend on.
       */
      logger.error({ err, name }, 'Rate limiter failed unexpectedly — allowing the request');
      return next();
    }
  };
}

const rejection = (req, res, next) => {
  next(ApiError.tooMany('Too many requests — please slow down and try again shortly'));
};

const baseLimiter = createLimiter({
  name: 'base',
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  skip: (req) => req.path.startsWith('/health'),
});

/**
 * Sync is deliberately more generous: a device returning from a week offline
 * legitimately pushes many batches back to back, and throttling it would mean
 * field data sitting unsynchronised.
 */
const syncLimiter = createLimiter({
  name: 'sync',
  windowMs: 60_000,
  max: config.rateLimit.syncMax,
});

/**
 * Public verification. Keyed strictly by IP — this endpoint is reachable
 * without an account, and it is the one surface where an attacker could try to
 * enumerate the register by walking tokens.
 */
const verificationLimiter = createLimiter({
  name: 'verify',
  windowMs: 60_000,
  max: 30,
  keyBy: (req) => `ip:${normaliseIp(req.ip)}`,
});

/** Report generation is expensive and exports personal data. */
const exportLimiter = createLimiter({
  name: 'export',
  windowMs: 5 * 60_000,
  max: 20,
});

/** Writes that create records — tighter than reads. */
const writeLimiter = createLimiter({
  name: 'write',
  windowMs: 60_000,
  max: 60,
});

/**
 * Failed-authentication throttle.
 *
 * Ordinary rate limiting counts all requests equally, so a caller probing with
 * stolen or forged tokens looks exactly like a busy officer. These two pieces
 * count only REJECTED authentication attempts, per IP, and start refusing once
 * the threshold is crossed — which is what turns token replay and invitation
 * probing into something detectable and bounded.
 *
 * Failures are counted in Redis so the threshold holds across instances, and
 * the counter is cleared on a successful authentication.
 */
const AUTH_FAILURE_WINDOW_SECONDS = 15 * 60;

const failureKey = (req) => `${config.redis.prefix}:authfail:${normaliseIp(req.ip)}`;

/** Called from the error handler whenever a 401/403 is produced. */
async function recordAuthFailure(req) {
  try {
    const key = failureKey(req);
    let count;

    try {
      count = await incrementWithTtl(key, AUTH_FAILURE_WINDOW_SECONDS);
    } catch {
      // Degrade to a per-process counter rather than losing the protection.
      count = localIncrement(key, AUTH_FAILURE_WINDOW_SECONDS * 1000);
    }

    if (count === config.auth.maxFailuresPerWindow) {
      logger.warn(
        { ip: normaliseIp(req.ip), count, path: req.path },
        'Authentication failure threshold reached — further attempts will be refused'
      );
    }
    return count;
  } catch (err) {
    logger.debug({ err }, 'Could not record the authentication failure');
    return 0;
  }
}

/** Clears the counter once the caller proves they hold a valid token. */
async function clearAuthFailures(req) {
  const key = failureKey(req);
  localCounters.delete(key);
  try {
    await client.del(key);
  } catch {
    // Non-fatal: the counter expires on its own.
  }
}

/** Refuses further attempts from a source that keeps failing. */
async function authFailureGuard(req, res, next) {
  try {
    const key = failureKey(req);
    let count;

    try {
      count = Number((await client.get(key)) ?? 0);
    } catch {
      count = localCounters.get(key)?.hits ?? 0;
    }

    if (count >= config.auth.maxFailuresPerWindow) {
      res.setHeader('Retry-After', String(AUTH_FAILURE_WINDOW_SECONDS));
      return next(
        ApiError.tooMany('Too many failed authentication attempts — try again later', {
          code: 'AUTH_FAILURES_EXCEEDED',
        })
      );
    }
  } catch (err) {
    // Fail open: a faulty guard must not lock out the register.
    logger.debug({ err }, 'Auth-failure guard unavailable');
  }
  return next();
}

module.exports = {
  baseLimiter,
  syncLimiter,
  verificationLimiter,
  exportLimiter,
  writeLimiter,
  createLimiter,
  identify,
  recordAuthFailure,
  clearAuthFailures,
  authFailureGuard,
  AUTH_FAILURE_WINDOW_SECONDS,
};
