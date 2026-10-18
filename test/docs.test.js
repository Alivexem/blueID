'use strict';

/**
 * Documentation accuracy.
 *
 * The Swagger description is the contract the portal and the field app are
 * built against, and prose drifts silently — nothing fails when a sentence
 * stops being true. These tests fail instead.
 *
 * They exist because real drift was found: the docs still said invited
 * officers signed in through Firebase (they get a temporary password), that
 * suspension revoked Firebase tokens (it revokes local sessions), that
 * login allowed 10 attempts per IP (it is now two tiers), and that rate
 * limits were shared across instances (they are per process).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const spec = require('../src/docs/openapi');
const { ALL_CODES, GROUPS } = require('../src/docs/errors');

const SRC = path.join(__dirname, '..', 'src');

/** Every `code:` string the application can actually return. */
function thrownCodes() {
  const codes = new Set();

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The docs describe codes; they do not throw them.
        if (entry.name !== 'docs') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(/code:\s*'([A-Z][A-Z0-9_]{3,})'/g)) {
        codes.add(match[1]);
      }
    }
  })(SRC);

  return codes;
}

test('the spec builds and covers the whole API', () => {
  const operations = Object.values(spec.paths).reduce(
    (total, item) =>
      total +
      Object.keys(item).filter((m) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).length,
    0
  );

  assert.ok(Object.keys(spec.paths).length > 80, 'the documented surface looks too small');
  assert.ok(operations > 100, `only ${operations} operations documented`);
  assert.ok(spec.info?.description?.length > 5000, 'the narrative is missing');
});

test('every error code the API can return is documented', () => {
  /**
   * A client branches on `code`. An undocumented one means a frontend
   * developer meets it for the first time in production, with nothing to
   * tell them whether to retry, re-authenticate or show the user a message.
   */
  const thrown = thrownCodes();
  const documented = new Set(ALL_CODES);

  const missing = [...thrown].filter((code) => !documented.has(code)).sort();

  assert.deepEqual(
    missing,
    [],
    `these codes are thrown but not in src/docs/errors.js:\n  ${missing.join('\n  ')}`
  );
});

test('the error reference does not describe codes that cannot happen', () => {
  // The opposite drift: a code removed from the application but left in the
  // documentation, which sends a client branching on something unreachable.
  const thrown = thrownCodes();

  // Codes produced by the error handler's status mapping rather than by an
  // explicit `code:` literal.
  const DERIVED = new Set([
    'BAD_REQUEST', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT',
    'VALIDATION_ERROR', 'RATE_LIMITED', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE',
    'DUPLICATE_KEY', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE',
  ]);

  const phantom = ALL_CODES.filter((code) => !thrown.has(code) && !DERIVED.has(code)).sort();

  assert.deepEqual(
    phantom,
    [],
    `documented but never thrown:\n  ${phantom.join('\n  ')}`
  );
});

test('the documentation does not describe removed dependencies', () => {
  /**
   * Firebase and Redis were removed from this branch. The docs described
   * both as load-bearing — telling a reader that credentials live in
   * Firebase, which was the first thing they would read about auth.
   */
  const docsDir = path.join(SRC, 'docs');
  const combined = fs
    .readdirSync(docsDir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(docsDir, f), 'utf8'))
    .join('\n');

  for (const term of ['Firebase', 'firebase', 'Upstash']) {
    assert.ok(
      !combined.includes(term),
      `the docs still mention ${term}, which this branch does not use`
    );
  }
});

test('the documented role capability counts match the permission table', () => {
  // The role table in the narrative is generated from ROLE_PERMISSIONS, so
  // this guards the sentence next to it — the Super Administrator being the
  // SMALLEST role is the surprising part, and the part most likely to be
  // "corrected" by someone who assumes otherwise.
  const { ROLE_PERMISSIONS, ROLES } = require('../src/config/constants');
  const description = spec.info.description;

  const superCount = ROLE_PERMISSIONS[ROLES.SUPER_ADMIN].length;
  const stateCount = ROLE_PERMISSIONS[ROLES.STATE_ADMIN].length;

  assert.ok(
    superCount < stateCount,
    'the Super Administrator should hold fewer capabilities than the State Administrator'
  );
  assert.match(
    description,
    new RegExp(`\\\`SUPER_ADMIN\\\`\\s*\\|\\s*${superCount}\\s*\\|`),
    `the role table should show SUPER_ADMIN with ${superCount} capabilities`
  );
  assert.match(
    description,
    /smallest role in this system|deliberately the smallest role/i,
    'the narrative should say the Super Administrator is the smallest role, not the largest'
  );
});

test('the login documentation states the rate limits that are configured', () => {
  const config = require('../src/config');
  const description = spec.info.description;

  assert.ok(
    description.includes(String(config.auth.loginAttemptsPerAccount)),
    'the per-account login limit is not in the narrative'
  );
  assert.ok(
    description.includes(String(config.auth.loginAttemptsPerIp)),
    'the per-IP login ceiling is not in the narrative'
  );
  assert.ok(
    /per instance|per process/i.test(description),
    'the narrative should not imply rate limits are shared across instances'
  );
});

/**
 * Every ApiError construction in the application, as code -> set of statuses.
 *
 * Attribution is paren-balanced: a `code:` literal counts against an
 * `ApiError` call only while that call's argument list is still open. A
 * nearest-preceding-match window was tried first and attributed codes to the
 * wrong call, which is the same mistake that once made a guard test pass
 * against a neighbouring route's middleware.
 */
function thrownStatuses() {
  const METHOD = {
    badRequest: 400, unauthorized: 401, forbidden: 403, notFound: 404,
    conflict: 409, unprocessable: 422, tooMany: 429, internal: 500, unavailable: 503,
  };
  const out = new Map();

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'docs') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');

      const calls = [];
      for (const m of source.matchAll(/new ApiError\(\s*(\d{3})|ApiError\.(\w+)\(/g)) {
        const status = m[1] ? Number(m[1]) : METHOD[m[2]];
        if (status) calls.push({ at: m.index + m[0].length, status });
      }

      for (const m of source.matchAll(/code:\s*'([A-Z][A-Z0-9_]{3,})'/g)) {
        for (let i = calls.length - 1; i >= 0; i -= 1) {
          if (calls[i].at > m.index) continue;
          const seg = source.slice(calls[i].at, m.index);
          const depth = 1 + (seg.split('(').length - 1) - (seg.split(')').length - 1);
          if (depth > 0) {
            if (!out.has(m[1])) out.set(m[1], new Set());
            out.get(m[1]).add(calls[i].status);
          }
          break;
        }
      }
    }
  })(SRC);

  return out;
}

test('each documented status is the status the code actually returns', () => {
  /**
   * The code list was already guarded; the statuses next to it were not, and
   * ten of them were wrong — DEVICE_REQUIRED documented 400 against a live
   * 401, BATCH_TOO_LARGE 413 against 400, UNSUPPORTED_MEDIA_TYPE 415 against
   * 400. A client written from that table branches on a status it will never
   * see, and the mistake is invisible until someone compares them by hand.
   */
  const actual = thrownStatuses();
  const documented = new Map(
    GROUPS.flatMap(([, rows]) => rows.map(([code, status]) => [code, status]))
  );

  const wrong = [];
  for (const [code, status] of documented) {
    const thrown = actual.get(code);
    if (thrown && !thrown.has(status)) {
      wrong.push(`${code}: documented ${status}, code returns ${[...thrown].join(', ')}`);
    }
  }

  assert.deepEqual(wrong, [], `the error reference disagrees with the code:\n  ${wrong.join('\n  ')}`);
});

test('no error code is returned with two different statuses', () => {
  /**
   * PAYLOAD_TOO_LARGE was thrown as 400 by the body-size handler and 413 by
   * the image upload. A client cannot branch on either, and whichever it
   * picks works until the request happens to fail the other way.
   */
  const actual = thrownStatuses();
  const ambiguous = [...actual]
    .filter(([, statuses]) => statuses.size > 1)
    .map(([code, statuses]) => `${code}: ${[...statuses].sort().join(' and ')}`);

  assert.deepEqual(ambiguous, [], `one code, several statuses:\n  ${ambiguous.join('\n  ')}`);
});
