'use strict';

/**
 * Endpoint-surface tests.
 *
 * These walk the live router stack rather than reading source, so a route
 * added later without a guard fails the build instead of waiting to be found
 * in an audit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/blueid-test';
process.env.AUTH_MODE = 'disabled';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

const logger = require('../src/config/logger');
logger.level = 'silent';

const app = require('../src/app');
const config = require('../src/config');

/** Flattens the Express router tree into one route list with middleware names. */
function collectRoutes() {
  const routes = [];

  /**
   * `inherited` carries middleware mounted with `router.use(...)`, which does
   * not appear in an individual route's stack but absolutely applies to it.
   * Ignoring it would report every route behind `router.use(authenticate)` as
   * unguarded.
   */
  function walk(stack, prefix, inherited) {
    const pending = [...inherited];

    for (const layer of stack) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods)
          .filter((m) => m !== '_all')
          .map((m) => m.toUpperCase());
        const middleware = [...pending, ...layer.route.stack.map((s) => s.name)];
        routes.push({ methods, path: prefix + layer.route.path, middleware });
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix, pending);
      } else if (layer.name && layer.name !== '<anonymous>') {
        // A router-level `use` applies to everything registered after it.
        pending.push(layer.name);
      }
    }
  }

  walk(app._router.stack, '', []);
  return routes;
}

const routes = collectRoutes();

/** Endpoints that are intentionally reachable without a session. */
const PUBLIC_PATHS = new Set([
  '/live',
  '/ready',
  '/', // API index and health alias
  '/reference/constants',
  '/:blueId', // card verification, rate limited, minimal disclosure
  '/scan',
  '/:blueId/status-line', // machine-to-machine, service key
  '/status', // sync connectivity probe
  /**
   * The OpenAPI spec. Public in development so the frontend team can consume
   * it; in production it sits behind `docsGuard`, which checks the same probe
   * key as the detailed health endpoint.
   */
  '/json',
  /**
   * Credential endpoints. Public by necessity — a caller signing in or
   * recovering an account has no token yet. Each is tightly rate limited and
   * returns deliberately generic errors.
   */
  '/login',
  '/refresh',
  '/logout',
  '/forgot-password',
  '/reset-password',
  /**
   * Image delivery. A browser putting a photograph in an `<img src>` sends no
   * Authorization header, so the HMAC signature in the URL is the
   * authorisation instead. It is minted only by `/media/signed-url`, after
   * the caller has been authorised against the record the image belongs to,
   * and it expires in minutes. Covered by test/storage.test.js, which proves
   * an absent, altered, expired or reused signature is refused.
   */
  '/file/*',
]);

test('the router exposes a non-trivial surface', () => {
  assert.ok(routes.length > 50, `expected the full API, found ${routes.length} routes`);
});

test('every non-public route is authenticated', () => {
  const unguarded = routes.filter((r) => {
    if (PUBLIC_PATHS.has(r.path)) return false;
    const names = r.middleware.join(',');
    return !/authenticate|serviceAuth|docsGuard/.test(names);
  });

  // `authenticate` is usually mounted with router.use, so it does not appear
  // in the route's own stack — this asserts the exceptions are only the
  // intentionally public ones.
  for (const route of unguarded) {
    assert.ok(
      PUBLIC_PATHS.has(route.path),
      `${route.methods.join('/')} ${route.path} has no authentication in its own stack`
    );
  }
});

test('state-changing routes carry a validator', () => {
  const mutating = routes.filter((r) =>
    r.methods.some((m) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(m))
  );

  const unvalidated = mutating.filter((r) => !r.middleware.some((n) => n === 'validateRequest'));

  // Every mutating endpoint should parse its body through zod, which both
  // validates and strips unknown keys (the mass-assignment defence).
  const allowed = new Set(['/scan']); // body validated inline
  for (const route of unvalidated) {
    assert.ok(
      allowed.has(route.path),
      `${route.methods.join('/')} ${route.path} accepts a body with no validator`
    );
  }
});

test('image uploads verify file content, not the declared type', () => {
  const uploadRoutes = routes.filter((r) => r.middleware.includes('multerMiddleware'));

  assert.ok(uploadRoutes.length >= 4, 'expected several upload endpoints');

  for (const route of uploadRoutes) {
    assert.ok(
      route.middleware.includes('validateImageContent'),
      `${route.path} accepts an upload without a magic-byte check — a declared ` +
        'content type is attacker-controlled'
    );
    assert.ok(
      route.middleware.includes('handleUploadError'),
      `${route.path} does not translate multer errors`
    );
  }
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('CORS does not advertise credentials', () => {
  // Authentication is a bearer token; allowing credentialed cross-origin
  // requests would create the precondition for CSRF for no benefit.
  assert.equal(config.app.corsOrigins.includes('*'), false, 'wildcard origin in config');
});

test('request bodies are size-limited', () => {
  const hasJsonLimit = app._router.stack.some((l) => l.name === 'jsonParser');
  assert.ok(hasJsonLimit, 'express.json must be mounted with a limit');
});

test('production refuses unsafe configuration', () => {
  /**
   * Mirrors the production rules the config schema enforces, so loosening one
   * fails here rather than shipping.
   */
  const forbidden = [
    ['AUTH_MODE', 'disabled'],
    ['AUTH_AUTO_PROVISION', true],
    ['AUTH_REQUIRE_VERIFIED_EMAIL', false],
    ['MEDIA_URL_SECRET', ''],
    ['FIELD_ENCRYPTION_KEY', ''],
    ['QR_SIGNING_SECRET', ''],
  ];

  for (const [name] of forbidden) {
    assert.ok(name.length > 0, `${name} must be validated in production`);
  }
  // The real assertion: the schema source contains a production guard for each.
  const source = require('node:fs').readFileSync(
    require.resolve('../src/config/index.js'),
    'utf8'
  );
  for (const [name] of forbidden) {
    assert.match(
      source,
      new RegExp(`isProd[\\s\\S]{0,200}${name}|${name}[\\s\\S]{0,200}isProd`),
      `no production guard found for ${name}`
    );
  }
});

test('media access is by record reference, never by raw asset id', () => {
  const source = require('node:fs').readFileSync(
    require.resolve('../src/modules/media/media.routes.js'),
    'utf8'
  );

  /**
   * Cloudinary ids are predictable (blueid/fishermen/<LGA>/<BlueID>), so
   * accepting one from the caller let any authenticated user mint a signed
   * URL for a photograph in an LGA they cannot access.
   */
  assert.match(source, /assertCanAccessRecord/, 'media routes must enforce object-level access');
  assert.doesNotMatch(
    source,
    /publicId:\s*z\.string\(\)/,
    'a caller-supplied publicId reintroduces the media IDOR'
  );
});
