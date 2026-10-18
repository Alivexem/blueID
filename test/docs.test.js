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
const { ALL_CODES } = require('../src/docs/errors');

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
