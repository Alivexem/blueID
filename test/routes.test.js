'use strict';

/**
 * The documented surface and the served surface must be the same surface.
 *
 * `/equipments` was documented in the OpenAPI spec, rendered on the Swagger
 * page and listed in the frontend guide, while the application mounted
 * `/equipment`. Every other collection here is plural, so the documentation
 * was the reasonable thing to believe — a frontend developer wrote against it
 * and got `404 ROUTE_NOT_FOUND` from seven operations. Nothing in the build
 * compared the two lists, so it surfaced as a bug report.
 *
 * WHY THIS MAKES REAL REQUESTS
 *
 * The obvious alternative is to walk `app._router` and compare path strings.
 * That was tried: a mounted sub-router keeps its prefix only inside
 * `layer.regexp`, and recovering it means parsing an escaped regular
 * expression whose shape is an Express implementation detail. A first attempt
 * at exactly that reported all 122 operations missing, which is a test that
 * would fail for the wrong reason every time Express changed.
 *
 * Asking the application is not ambiguous. `ROUTE_NOT_FOUND` comes from the
 * 404 handler, which runs after routing, so an unauthenticated request
 * separates "no such route" from "route exists and refused me" without any
 * credentials, whatever a routed request then answers.
 *
 * Nothing is written: no database connection is opened, and every request is
 * rejected by `authenticate` before a handler runs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.QR_SIGNING_SECRET = process.env.QR_SIGNING_SECRET || 'test-qr-secret-value';
process.env.FIELD_ENCRYPTION_KEY =
  process.env.FIELD_ENCRYPTION_KEY || 'test-field-encryption-key-at-least-32-chars';

/**
 * Authentication is forced back ON for this file, overriding the harness.
 *
 * test/setup/globalSetup.js sets AUTH_MODE=disabled for the whole run, which
 * would let all 122 probes through to their real handlers — including the
 * DELETEs. Today they fail short of any data because this file opens no
 * database connection, but that is luck, not a guarantee: the day somebody
 * adds a connect() here, this test would start issuing destructive requests
 * against the test database.
 *
 * With `local` every probe stops at `TOKEN_MISSING` instead, which is both
 * the fast path and the safe one — and it is all this test needs, since it
 * only has to tell a refusal from a missing route.
 */
process.env.AUTH_MODE = 'local';
process.env.AUTH_JWT_SECRET =
  process.env.AUTH_JWT_SECRET || 'test-auth-jwt-secret-at-least-32-characters-long';
process.env.AUTH_MAX_FAILURES_PER_WINDOW = '1000000';
process.env.RATE_LIMIT_MAX = '1000000';

const logger = require('../src/config/logger');
logger.level = 'silent';

const app = require('../src/app');
const spec = require('../src/docs/openapi');

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

function documentedOperations() {
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (METHODS.includes(method)) ops.push({ method: method.toUpperCase(), path });
    }
  }
  return ops;
}

function request(port, method, path) {
  return new Promise((resolve) => {
    const req = http.request(
      { port, method, path, headers: { 'content-type': 'application/json' } },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let code = null;
          try { code = JSON.parse(body)?.error?.code; } catch { /* not JSON */ }
          resolve({ status: res.statusCode, code });
        });
      }
    );
    req.on('error', () => resolve({ status: 0, code: 'REQUEST_FAILED' }));
    req.end(method === 'GET' || method === 'DELETE' ? undefined : '{}');
  });
}

test('every documented endpoint is actually served', async () => {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  try {
    const ops = documentedOperations();
    assert.ok(ops.length > 100, `only ${ops.length} operations in the spec — the probe is wrong`);

    const missing = [];
    for (const { method, path } of ops) {
      // A path parameter's value is irrelevant: routing matches the shape.
      const url = path.replace(/\{[^}]+\}/g, '000000000000000000000000');
      // eslint-disable-next-line no-await-in-loop
      const res = await request(port, method, url);

      if (res.code === 'AUTH_FAILURES_EXCEEDED' || res.code === 'RATE_LIMITED') {
        /**
         * The limiters answer before routing, so a throttled probe cannot see
         * a missing route and would report a clean run. Fail loudly instead:
         * a silent false pass is the one outcome this test must not produce.
         */
        assert.fail(
          `rate limited at ${method} ${path} — raise AUTH_MAX_FAILURES_PER_WINDOW, ` +
            'otherwise this test reports success without having checked anything'
        );
      }

      if (res.code === 'ROUTE_NOT_FOUND') missing.push(`${method} ${path}`);
    }

    assert.deepEqual(
      missing,
      [],
      'these are documented but return 404 — a client written from the spec breaks on them:\n  ' +
        missing.join('\n  ')
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('equipment is reachable at the documented plural path', async () => {
  // The specific regression. `/equipment` is kept as an alias, so both answer.
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();

  try {
    for (const path of ['/api/v1/equipments', '/api/v1/equipment']) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(port, 'GET', path);
      // Only routing is asserted. What a routed request answers depends on
      // the auth mode and whether a database is up, and neither is this
      // test's business — a 404 here is, and that is what broke the client.
      assert.notEqual(res.code, 'ROUTE_NOT_FOUND', `${path} must be routed`);
      assert.notEqual(res.status, 404, `${path} must not 404`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
