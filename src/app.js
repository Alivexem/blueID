'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const config = require('./config');
const logger = require('./config/logger');
const { requestId, httpLogger } = require('./middleware/requestContext');
const { attachPrincipal } = require('./middleware/authenticate');
const { baseLimiter, authFailureGuard } = require('./middleware/rateLimiter');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { apiRouter, healthRoutes } = require('./routes');

const app = express();

/**
 * Behind a load balancer (Render, Fly, nginx) Express must be told to trust
 * the proxy, otherwise req.ip is the balancer's address and both rate limiting
 * and the audit trail record the wrong origin.
 */
if (config.app.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

// --- Security ---------------------------------------------------------------
app.use(
  helmet({
    // The API serves JSON and streamed files, never HTML pages, so the
    // document-oriented policies are tightened to nothing rather than tuned.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
  })
);

const corsOptions = {
  origin(origin, callback) {
    // No origin: server-to-server, curl, or the Android app — all allowed.
    // Browser requests must come from a configured portal origin.
    if (!origin) return callback(null, true);
    if (config.app.corsOrigins.includes('*') || config.app.corsOrigins.includes(origin)) {
      return callback(null, true);
    }
    logger.warn({ origin }, 'Blocked a cross-origin request from an unlisted origin');
    return callback(new Error('Origin not permitted by CORS policy'));
  },
  /**
   * No cookies are used — authentication is a bearer token — so credentialed
   * cross-origin requests are never needed. Leaving this on would have
   * allowed a browser to attach ambient credentials to API calls, which is
   * the precondition for CSRF.
   */
  credentials: false,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'X-Device-Id',
    'X-Api-Key',
    'X-Service-Name',
    // Development-only identity headers (AUTH_MODE=disabled).
    'X-Debug-Uid',
    'X-Debug-Role',
    'X-Debug-Email',
    'X-Debug-Name',
  ],
  exposedHeaders: ['X-Request-Id', 'Content-Disposition', 'RateLimit', 'RateLimit-Policy'],
  maxAge: 86400,
};
app.use(cors(corsOptions));

// --- Parsing & context ------------------------------------------------------
app.use(requestId);
app.use(httpLogger);

/**
 * 2MB covers a large sync batch of JSON records. Photographs never travel
 * through this path — they go to Cloudinary directly or as multipart.
 */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Skip compression for streamed exports, which are already written in chunks.
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.startsWith(`${config.app.apiPrefix}/reports`)) return false;
      return compression.filter(req, res);
    },
  })
);

// --- Routes -----------------------------------------------------------------
app.use('/health', healthRoutes);

// Interactive API documentation and the raw OpenAPI spec.
app.use('/docs', require('./docs'));

/**
 * `attachPrincipal` runs BEFORE the limiter so rate limits are keyed to a
 * cryptographically verified account rather than to an IP address — otherwise
 * a whole LGA office behind one connection shares a single budget. It never
 * rejects; the real 401 comes from `authenticate` inside each module router.
 */
app.use(
  config.app.apiPrefix,
  // Refuses a source that has been failing authentication repeatedly, before
  // any work is done for it.
  authFailureGuard,
  attachPrincipal,
  baseLimiter,
  apiRouter
);

// Friendly root so a bare GET / is not a 404.
app.get('/', (req, res) => {
  res.redirect(config.app.apiPrefix);
});

// --- Errors -----------------------------------------------------------------
app.use(notFound);
app.use(errorHandler);

module.exports = app;
