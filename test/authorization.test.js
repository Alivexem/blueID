'use strict';

/**
 * Authorization tests.
 *
 * These cover the defects that were found by audit and are easy to
 * reintroduce: a scope filter silently replaced by a search clause, an object
 * check that disagrees with the list filter, a cooperative officer scoped on a
 * field the collection does not have.
 *
 * They run against the pure filter/predicate functions, with no database, so
 * they are fast enough to run on every commit.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/blueid-test';
process.env.AUTH_MODE = 'disabled';

const {
  buildScopeFilter,
  recordMatchesScope,
  hasPermission,
  resolveWritableLga,
  assertNotSelfApproval,
} = require('../src/middleware/authorize');
const { andFilters } = require('../src/utils/query');
const { ROLES, PERMISSIONS } = require('../src/config/constants');

const ENUMERATOR_ID = '507f1f77bcf86cd799439011';
const OTHER_USER_ID = '507f1f77bcf86cd799439012';
const COMMUNITY_ID = '507f1f77bcf86cd799439021';
const COOP_ID = '507f1f77bcf86cd799439031';

const enumerator = {
  _id: ENUMERATOR_ID,
  role: ROLES.ENUMERATOR,
  scope: { lgas: ['BAK'], communities: [] },
};

const lgaAdmin = {
  _id: OTHER_USER_ID,
  role: ROLES.LGA_ADMIN,
  scope: { lgas: ['BAK'], communities: [] },
};

const stateAdmin = {
  _id: OTHER_USER_ID,
  role: ROLES.STATE_ADMIN,
  scope: { lgas: [], communities: [] },
};

const coopOfficer = {
  _id: OTHER_USER_ID,
  role: ROLES.COOPERATIVE_OFFICER,
  cooperative: COOP_ID,
  scope: { lgas: ['BAK'], communities: [] },
};

test('state-wide roles are unscoped', () => {
  assert.deepEqual(buildScopeFilter(stateAdmin), {});
  assert.equal(recordMatchesScope(stateAdmin, { lga: 'ODU' }), true);
});

test('an LGA admin is confined to their own LGAs', () => {
  assert.deepEqual(buildScopeFilter(lgaAdmin), { lga: { $in: ['BAK'] } });
  assert.equal(recordMatchesScope(lgaAdmin, { lga: 'BAK' }), true);
  assert.equal(recordMatchesScope(lgaAdmin, { lga: 'ODU' }), false);
});

test('a role with no assigned LGA can see nothing', () => {
  const unscoped = { _id: OTHER_USER_ID, role: ROLES.LGA_ADMIN, scope: { lgas: [] } };
  assert.deepEqual(buildScopeFilter(unscoped), { _id: null });
  assert.equal(recordMatchesScope(unscoped, { lga: 'BAK' }), false);
});

test('a missing user is denied rather than unscoped', () => {
  assert.deepEqual(buildScopeFilter(null), { _id: null });
  assert.equal(recordMatchesScope(null, { lga: 'BAK' }), false);
});

test('an enumerator sees their own records plus their posting', () => {
  const filter = buildScopeFilter(enumerator);
  assert.ok(filter.$or, 'expected an $or scope for an enumerator');
  assert.deepEqual(filter.$or[0], { registeredBy: ENUMERATOR_ID });
  assert.deepEqual(filter.$or[1], { lga: { $in: ['BAK'] } });
});

/**
 * The list filter and the object check must agree. The original defect was a
 * list that returned a row which then 403'd when opened.
 */
test('object check agrees with the scope filter for an enumerator', () => {
  // Own record in another LGA: visible in the filter, so must be openable.
  const ownRecordElsewhere = { lga: 'ODU', registeredBy: ENUMERATOR_ID };
  assert.equal(recordMatchesScope(enumerator, ownRecordElsewhere), true);

  // A colleague's record inside the posting.
  assert.equal(
    recordMatchesScope(enumerator, { lga: 'BAK', registeredBy: OTHER_USER_ID }),
    true
  );

  // A colleague's record outside the posting.
  assert.equal(
    recordMatchesScope(enumerator, { lga: 'ODU', registeredBy: OTHER_USER_ID }),
    false
  );
});

test('a community-posted enumerator is confined to that community', () => {
  const posted = {
    _id: ENUMERATOR_ID,
    role: ROLES.ENUMERATOR,
    scope: { lgas: ['BAK'], communities: [COMMUNITY_ID] },
  };

  const filter = buildScopeFilter(posted);
  assert.deepEqual(filter.$or[1], { community: { $in: [COMMUNITY_ID] } });

  assert.equal(recordMatchesScope(posted, { lga: 'BAK', community: COMMUNITY_ID }), true);
  // Same LGA but a different community is out of scope.
  assert.equal(
    recordMatchesScope(posted, { lga: 'BAK', community: '507f1f77bcf86cd799439099' }),
    false
  );
  // Populated community documents resolve too.
  assert.equal(
    recordMatchesScope(posted, { lga: 'BAK', community: { _id: COMMUNITY_ID, name: 'Abana' } }),
    true
  );
});

test('a cooperative officer is scoped by cooperative where the field exists', () => {
  const filter = buildScopeFilter(coopOfficer, { cooperativeField: 'cooperative.id' });
  assert.deepEqual(filter, { 'cooperative.id': COOP_ID });

  assert.equal(
    recordMatchesScope(coopOfficer, { cooperative: { id: COOP_ID } }, { cooperativeField: 'cooperative.id' }),
    true
  );
});

/**
 * Boats, engines and allocations carry no cooperative reference. Scoping them
 * on one matched nothing and silently returned an empty list.
 */
test('a cooperative officer falls back to LGA on collections without a cooperative field', () => {
  const filter = buildScopeFilter(coopOfficer, { cooperativeField: null });
  assert.deepEqual(filter, { lga: { $in: ['BAK'] } });
  assert.equal(recordMatchesScope(coopOfficer, { lga: 'BAK' }, { cooperativeField: null }), true);
  assert.equal(recordMatchesScope(coopOfficer, { lga: 'ODU' }, { cooperativeField: null }), false);
});

test('andFilters preserves a scope $or when a search clause adds its own', () => {
  const scope = buildScopeFilter(enumerator);
  const search = { $or: [{ 'match.normalizedPhone': '+2348031234567' }] };

  const combined = andFilters(scope, { isDeleted: { $ne: true } }, search);

  // Both $or groups must survive, under $and.
  assert.ok(Array.isArray(combined.$and), 'expected conflicting keys to move into $and');
  const serialised = JSON.stringify(combined);
  assert.match(serialised, /registeredBy/, 'scope ownership clause was dropped');
  assert.match(serialised, /normalizedPhone/, 'search clause was dropped');
});

test('andFilters merges non-conflicting keys flat', () => {
  const combined = andFilters({ lga: 'BAK' }, { status: 'ACTIVE' });
  assert.deepEqual(combined, { lga: 'BAK', status: 'ACTIVE' });
  assert.equal(combined.$and, undefined);
});

test('andFilters keeps both values when a key repeats', () => {
  const combined = andFilters({ lga: 'BAK' }, { lga: 'ODU' });
  assert.ok(combined.$and, 'a repeated key must not be overwritten');
  assert.deepEqual(combined, { lga: 'BAK', $and: [{ lga: 'ODU' }] });
});

test('permissions follow the role, not the rank alone', () => {
  // An enumerator registers but must never verify.
  assert.equal(hasPermission(enumerator, PERMISSIONS.FISHERMAN_CREATE), true);
  assert.equal(hasPermission(enumerator, PERMISSIONS.REGISTRATION_VERIFY), false);
  assert.equal(hasPermission(enumerator, PERMISSIONS.REPORT_EXPORT), false);
  assert.equal(hasPermission(enumerator, PERMISSIONS.FISHERMAN_READ_SENSITIVE), false);

  // Allocating and approving a benefit are deliberately separate grants.
  assert.equal(hasPermission(lgaAdmin, PERMISSIONS.BENEFIT_ALLOCATE), true);
  assert.equal(hasPermission(lgaAdmin, PERMISSIONS.BENEFIT_APPROVE), false);

  assert.equal(hasPermission(stateAdmin, PERMISSIONS.BENEFIT_APPROVE), true);
});

test('an enumerator cannot write outside their LGA', () => {
  assert.equal(resolveWritableLga(enumerator, 'BAK'), 'BAK');
  assert.throws(() => resolveWritableLga(enumerator, 'ODU'), /outside your scope/i);
  // A single assigned LGA is an unambiguous default.
  assert.equal(resolveWritableLga(enumerator, undefined), 'BAK');
});

test('an officer cannot approve a record they submitted', () => {
  const record = { registeredBy: ENUMERATOR_ID };
  const selfApprover = { _id: ENUMERATOR_ID, role: ROLES.LGA_ADMIN, scope: { lgas: ['BAK'] } };

  assert.throws(
    () => assertNotSelfApproval(selfApprover, record, { action: 'verify' }),
    /cannot verify a record you submitted/i
  );

  // A different officer may verify it.
  assert.doesNotThrow(() => assertNotSelfApproval(lgaAdmin, record, { action: 'verify' }));
  // State-wide roles are exempt, so a correction is always possible.
  assert.doesNotThrow(() =>
    assertNotSelfApproval({ ...stateAdmin, _id: ENUMERATOR_ID }, record, { action: 'verify' })
  );
});

// ---------------------------------------------------------------------------
// The Super Administrator is an oversight role
// ---------------------------------------------------------------------------

const superAdmin = { _id: '507f1f77bcf86cd799439099', role: ROLES.SUPER_ADMIN, scope: { lgas: [] } };

test('the super administrator holds oversight grants and no operational ones', () => {
  // What it is for.
  for (const granted of [
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.USER_ASSIGN_ROLE,
    PERMISSIONS.AUDIT_READ,
    PERMISSIONS.DASHBOARD_VIEW,
  ]) {
    assert.equal(hasPermission(superAdmin, granted), true, `${granted} must be granted`);
  }

  // Everything else belongs to the State Administrator and below. Listed one
  // by one rather than as a count, so adding a permission to the system
  // cannot quietly widen this role.
  for (const withheld of [
    PERMISSIONS.FISHERMAN_READ,
    PERMISSIONS.FISHERMAN_CREATE,
    PERMISSIONS.FISHERMAN_EDIT,
    PERMISSIONS.FISHERMAN_DELETE,
    PERMISSIONS.FISHERMAN_READ_SENSITIVE,
    PERMISSIONS.REGISTRATION_VERIFY,
    PERMISSIONS.REGISTRATION_STATUS,
    PERMISSIONS.DUPLICATE_RESOLVE,
    PERMISSIONS.DUPLICATE_MERGE,
    PERMISSIONS.ASSET_MANAGE,
    PERMISSIONS.ASSET_TRANSFER,
    PERMISSIONS.PROGRAMME_MANAGE,
    PERMISSIONS.BENEFIT_ALLOCATE,
    PERMISSIONS.BENEFIT_APPROVE,
    PERMISSIONS.BENEFIT_DELIVER,
    PERMISSIONS.COOPERATIVE_MANAGE,
    PERMISSIONS.COMMUNITY_MANAGE,
    PERMISSIONS.DEVICE_MANAGE,
    PERMISSIONS.SYNC_SUBMIT,
    PERMISSIONS.REPORT_EXPORT,
  ]) {
    assert.equal(hasPermission(superAdmin, withheld), false, `${withheld} must be withheld`);
  }
});

test('outranking the state administrator does not confer its abilities', () => {
  const { rankOf } = require('../src/middleware/authorize');

  // Rank still decides who may create whom...
  assert.ok(rankOf(ROLES.SUPER_ADMIN) > rankOf(ROLES.STATE_ADMIN));

  // ...but never what may be done. This is the pairing that matters: every
  // route that gates on rank alone would otherwise admit this role.
  assert.equal(hasPermission(superAdmin, PERMISSIONS.COMMUNITY_MANAGE), false);
  assert.equal(hasPermission(superAdmin, PERMISSIONS.COOPERATIVE_MANAGE), false);
  assert.equal(hasPermission(superAdmin, PERMISSIONS.PROGRAMME_MANAGE), false);
  assert.equal(hasPermission(stateAdmin, PERMISSIONS.COMMUNITY_MANAGE), true);
});

/**
 * Walks the mounted router with the authorization guards instrumented, so the
 * answer comes from the middleware Express will actually run rather than from
 * the shape of the source. An earlier version of this test matched text in the
 * route files and passed when the guard was deleted: the `requirePermission`
 * belonging to the handler above was inside its search window.
 */
function reachableBy(role) {
  const authorize = require('../src/middleware/authorize');
  const { ROLE_PERMISSIONS, ROLE_RANK } = require('../src/config/constants');

  const originals = {};
  for (const name of ['requirePermission', 'requireMinRole', 'requireRole']) {
    if (typeof authorize[name] !== 'function') continue;
    originals[name] = authorize[name];
    authorize[name] = (...args) => {
      const mw = originals[name](...args);
      const meta = { kind: name, args: args.flat().filter((a) => typeof a === 'string') };
      try {
        Object.defineProperty(mw, '__guard', { value: meta });
      } catch {
        /* a frozen middleware simply goes unlabelled */
      }
      return mw;
    };
  }

  let app;
  try {
    app = require('../src/app');
  } finally {
    for (const [name, fn] of Object.entries(originals)) authorize[name] = fn;
  }

  const found = [];
  const AUTH = new Set(['authenticate', 'optionalAuthenticate', 'serviceAuth']);
  const label = (h) => (h && h.__guard) || (h && AUTH.has(h.name) ? { kind: h.name } : null);

  const segment = (layer) => {
    const s = layer.regexp ? layer.regexp.source : '';
    if (!s || s === '^\\/?(?=\\/|$)') return '';
    return s
      .replace(/^\^/, '')
      .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
      .replace(/\$$/, '')
      .replace(/\\\//g, '/')
      .replace(/\(\?=\\\/\|\$\)/g, '');
  };

  (function walk(stack, prefix, inherited) {
    const acc = [...inherited];
    for (const layer of stack) {
      if (layer.route) {
        for (const sub of layer.route.stack) {
          const own = label(sub.handle);
          found.push({
            method: (sub.method || 'all').toUpperCase(),
            path: prefix + layer.route.path,
            guards: own ? [...acc, own] : acc,
          });
        }
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix + segment(layer), acc);
      } else {
        const g = label(layer.handle);
        if (g) acc.push(g);
      }
    }
  })((app._router || app.router).stack, '', []);

  // Union the per-handler rows for one METHOD+PATH.
  const merged = new Map();
  for (const r of found) {
    const key = `${r.method} ${r.path}`;
    if (!merged.has(key)) merged.set(key, { ...r, guards: [] });
    for (const g of r.guards) {
      const sig = `${g.kind}:${(g.args || []).join(',')}`;
      const list = merged.get(key).guards;
      if (!list.some((x) => `${x.kind}:${(x.args || []).join(',')}` === sig)) list.push(g);
    }
  }

  const passes = (g) => {
    if (g.kind === 'requirePermission') return (g.args || []).every((p) => (ROLE_PERMISSIONS[role] || []).includes(p));
    if (g.kind === 'requireMinRole') return ROLE_RANK[role] >= Math.max(...(g.args || []).map((r) => ROLE_RANK[r] || 0));
    if (g.kind === 'requireRole') return (g.args || []).includes(role);
    return true;
  };

  return [...merged.values()]
    .filter((r) => r.method !== 'ALL')
    .filter((r) => r.guards.some((g) => g.kind === 'authenticate'))
    .filter((r) => r.guards.every(passes))
    .map((r) => `${r.method} ${r.path}`);
}

test('the super administrator can change nothing outside accounts and its own session', () => {
  const writes = reachableBy(ROLES.SUPER_ADMIN).filter((r) => /^(POST|PATCH|PUT|DELETE)/.test(r));

  // Creating and administering accounts, and managing its own credentials.
  // Anything else appearing here is an operational power leaking back in.
  const allowed = /^(POST|PATCH|PUT|DELETE) \/api\/v1\/(users|auth)\//;
  const leaked = writes.filter((r) => !allowed.test(r));

  assert.deepEqual(leaked, [], `super admin can write outside accounts:\n${leaked.join('\n')}`);
  assert.ok(writes.some((r) => r === 'POST /api/v1/users/'), 'it must still create accounts');
});

test('the super administrator cannot read the citizen register', () => {
  const reachable = reachableBy(ROLES.SUPER_ADMIN);

  for (const blocked of [
    'GET /api/v1/fishermen/',
    'GET /api/v1/fishermen/:id',
    'GET /api/v1/reports/register.csv',
    'GET /api/v1/sync/pull',
  ]) {
    assert.ok(!reachable.includes(blocked), `${blocked} must be refused`);
  }

  // But oversight must work.
  for (const required of ['GET /api/v1/audit/', 'GET /api/v1/dashboard/summary', 'GET /api/v1/users/']) {
    assert.ok(reachable.includes(required), `${required} must be reachable`);
  }
});
