'use strict';

const ApiError = require('../utils/ApiError');
const { andFilters } = require('../utils/query');
const {
  ROLES,
  ROLE_RANK,
  STATE_WIDE_RANK,
  ROLE_PERMISSIONS,
  PERMISSIONS,
} = require('../config/constants');

/**
 * Authorization: what a role may do, and which rows it may touch.
 *
 * Three layers, each of which must hold on its own:
 *
 *   1. CAPABILITY  — `requirePermission(...)` on the route. Answers "may this
 *      role perform this kind of action at all?"
 *
 *   2. SCOPE FILTER — `buildScopeFilter()` merged into every list/aggregate
 *      query. Answers "which rows may this user see?" It is applied inside the
 *      services so a route cannot forget it.
 *
 *   3. OBJECT CHECK — `assertCanAccessRecord()` after loading a document.
 *      Answers "may this user touch THIS row?" This is the defence against
 *      IDOR: knowing a record's id must never be sufficient to read it.
 *
 * Layers 2 and 3 must agree. They previously did not — the filter granted an
 * enumerator their own registrations while the object check demanded an LGA
 * match, so a list returned rows that 403'd when opened. Both now run through
 * the same `recordMatchesScope` logic.
 */

const rankOf = (role) => ROLE_RANK[role] ?? 0;

const permissionsFor = (role) => ROLE_PERMISSIONS[role] || [];

/** Does this user hold the capability? */
function hasPermission(user, permission) {
  if (!user) return false;
  return permissionsFor(user.role).includes(permission);
}

/** Route guard: requires every listed capability. */
function requirePermission(...required) {
  const needed = required.flat();
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());

    const missing = needed.filter((p) => !hasPermission(req.user, p));
    if (missing.length) {
      return next(
        ApiError.forbidden('Your role cannot perform this action', {
          code: 'MISSING_PERMISSION',
          details: { required: needed, missing, yourRole: req.user.role },
        })
      );
    }
    next();
  };
}

/** Route guard: requires at least one of the listed capabilities. */
function requireAnyPermission(...options) {
  const accepted = options.flat();
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!accepted.some((p) => hasPermission(req.user, p))) {
      return next(
        ApiError.forbidden('Your role cannot perform this action', {
          code: 'MISSING_PERMISSION',
          details: { requiredAnyOf: accepted, yourRole: req.user.role },
        })
      );
    }
    next();
  };
}

/** Allow only the listed roles. Prefer `requirePermission` where possible. */
function requireRole(...allowed) {
  const allowedSet = new Set(allowed.flat());
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (!allowedSet.has(req.user.role)) {
      return next(
        ApiError.forbidden('Your role cannot perform this action', {
          details: { requiredRole: [...allowedSet], yourRole: req.user.role },
        })
      );
    }
    next();
  };
}

/** Allow any role at or above `role` in the hierarchy. */
function requireMinRole(role) {
  const required = rankOf(role);
  return (req, res, next) => {
    if (!req.user) return next(ApiError.unauthorized());
    if (rankOf(req.user.role) < required) {
      return next(
        ApiError.forbidden('Your role cannot perform this action', {
          details: { minimumRole: role, yourRole: req.user.role },
        })
      );
    }
    next();
  };
}

const requireAdmin = requireMinRole(ROLES.LGA_ADMIN);
const requireStateAdmin = requireMinRole(ROLES.STATE_ADMIN);

/** State-wide roles are not restricted to particular LGAs. */
function isStateWide(user) {
  return rankOf(user?.role) >= STATE_WIDE_RANK;
}

function scopedLgas(user) {
  return Array.isArray(user?.scope?.lgas) ? user.scope.lgas.filter(Boolean) : [];
}

function scopedCommunities(user) {
  return Array.isArray(user?.scope?.communities)
    ? user.scope.communities.filter(Boolean).map(String)
    : [];
}

/**
 * Default field names. Collections differ: `Engine` has no `community`,
 * `Boat` has no `cooperative`. Passing `null` for a field tells the scope
 * builder that the collection does not carry it, so it falls back to a
 * coarser dimension instead of silently filtering on a field that does not
 * exist (which matches nothing and returns an empty, wrong answer).
 */
const DEFAULT_FIELDS = {
  lgaField: 'lga',
  communityField: 'community',
  ownerField: 'registeredBy',
  cooperativeField: null,
};

/**
 * The Mongo filter fragment restricting a user to the rows they may read.
 *
 * ALWAYS combine with other conditions via `andFilters` — never by spreading,
 * because this fragment frequently contains `$or`:
 *
 *   const filter = andFilters(buildScopeFilter(user), { status: 'ACTIVE' });
 */
function buildScopeFilter(user, options = {}) {
  const { lgaField, communityField, ownerField, cooperativeField } = {
    ...DEFAULT_FIELDS,
    ...options,
  };

  if (!user) return { _id: null }; // deny-all rather than leak on a bug
  if (isStateWide(user)) return {};

  const lgas = scopedLgas(user);
  const communities = scopedCommunities(user);

  if (user.role === ROLES.ENUMERATOR) {
    const clauses = [];

    // What they captured themselves, wherever it is.
    if (ownerField) clauses.push({ [ownerField]: user._id });
    // Plus their posting, so a colleague's record can be found and corrected
    // rather than registered a second time.
    if (communities.length && communityField) {
      clauses.push({ [communityField]: { $in: communities } });
    } else if (lgas.length && lgaField) {
      clauses.push({ [lgaField]: { $in: lgas } });
    }

    if (!clauses.length) return { _id: null };
    return clauses.length === 1 ? clauses[0] : { $or: clauses };
  }

  if (user.role === ROLES.COOPERATIVE_OFFICER && user.cooperative) {
    // Only collections that actually carry a cooperative reference can be
    // scoped by it; elsewhere fall back to the officer's LGA.
    if (cooperativeField) return { [cooperativeField]: user.cooperative };
    if (lgas.length && lgaField) return { [lgaField]: { $in: lgas } };
    return { _id: null };
  }

  if (lgas.length && lgaField) return { [lgaField]: { $in: lgas } };

  // An LGA-level role with no assigned LGA can see nothing until configured.
  return { _id: null };
}

/** True when `user` may read/write records in `lga`. */
function canAccessLga(user, lga) {
  if (!user || !lga) return false;
  if (isStateWide(user)) return true;
  return scopedLgas(user).includes(lga);
}

/**
 * Object-level check (layer 3). Mirrors `buildScopeFilter` exactly, so a row
 * returned by a scoped list is always openable by the same user.
 */
function recordMatchesScope(user, record, options = {}) {
  const { lgaField, communityField, ownerField, cooperativeField } = {
    ...DEFAULT_FIELDS,
    ...options,
  };

  if (!user || !record) return false;
  if (isStateWide(user)) return true;

  const lgas = scopedLgas(user);
  const communities = scopedCommunities(user);

  const recordLga = lgaField ? record[lgaField] : undefined;
  const recordCommunity = communityField ? record[communityField] : undefined;
  const recordOwner = ownerField ? record[ownerField] : undefined;

  // `community` may be populated, a raw id, or absent.
  const communityId = recordCommunity?._id
    ? String(recordCommunity._id)
    : recordCommunity
      ? String(recordCommunity)
      : null;

  if (user.role === ROLES.ENUMERATOR) {
    const ownerId = recordOwner?._id ? String(recordOwner._id) : recordOwner ? String(recordOwner) : null;
    if (ownerId && ownerId === String(user._id)) return true;
    if (communities.length) return Boolean(communityId && communities.includes(communityId));
    return Boolean(recordLga && lgas.includes(recordLga));
  }

  if (user.role === ROLES.COOPERATIVE_OFFICER && user.cooperative) {
    if (cooperativeField) {
      const value = cooperativeField
        .split('.')
        .reduce((acc, key) => (acc == null ? acc : acc[key]), record);
      const coopId = value?._id ? String(value._id) : value ? String(value) : null;
      if (coopId && coopId === String(user.cooperative)) return true;
      return false;
    }
    return Boolean(recordLga && lgas.includes(recordLga));
  }

  return Boolean(recordLga && lgas.includes(recordLga));
}

/**
 * Guards a loaded document. Use this instead of `assertCanAccessLga` whenever
 * the record itself is in hand — it is the IDOR defence.
 */
function assertCanAccessRecord(user, record, options = {}) {
  if (!recordMatchesScope(user, record, options)) {
    // Deliberately vague: confirming a record exists but is out of scope is
    // itself an information leak when ids can be guessed.
    throw ApiError.notFound('Record not found');
  }
  return record;
}

/** Guards a bare LGA code, e.g. one supplied as a query parameter. */
function assertCanAccessLga(user, lga) {
  if (!canAccessLga(user, lga)) {
    throw ApiError.forbidden('That Local Government Area is outside your scope', {
      details: { requestedLga: lga, yourLgas: scopedLgas(user) },
    });
  }
}

/** Verification and status changes are reserved for a verifying role. */
function assertCanVerify(user) {
  if (!hasPermission(user, PERMISSIONS.REGISTRATION_VERIFY)) {
    throw ApiError.forbidden('Only authorised administrators may verify a record');
  }
}

/**
 * Separation of duties: the officer who captured or last edited a record must
 * not be the one who verifies it, and nobody approves their own allocation.
 * Reviewed separately from role, because an LGA administrator may legitimately
 * register someone and must still not sign off their own entry.
 */
function assertNotSelfApproval(user, record, { actorField = 'registeredBy', action = 'approve' } = {}) {
  const value = record?.[actorField];
  const actorId = value?._id ? String(value._id) : value ? String(value) : null;

  if (actorId && actorId === String(user._id) && !isStateWide(user)) {
    throw ApiError.forbidden(
      `You cannot ${action} a record you submitted yourself — ask another officer to review it`,
      { code: 'SELF_APPROVAL_FORBIDDEN' }
    );
  }
}

/** Validates an LGA supplied in a request body against the writer's scope. */
function resolveWritableLga(user, requestedLga) {
  if (isStateWide(user)) {
    if (!requestedLga) throw ApiError.badRequest('lga is required');
    return requestedLga;
  }

  const lgas = scopedLgas(user);
  if (!requestedLga) {
    if (lgas.length === 1) return lgas[0]; // unambiguous default
    throw ApiError.badRequest('lga is required');
  }
  assertCanAccessLga(user, requestedLga);
  return requestedLga;
}

module.exports = {
  PERMISSIONS,
  hasPermission,
  permissionsFor,
  requirePermission,
  requireAnyPermission,
  requireRole,
  requireMinRole,
  requireAdmin,
  requireStateAdmin,
  isStateWide,
  buildScopeFilter,
  recordMatchesScope,
  assertCanAccessRecord,
  canAccessLga,
  assertCanAccessLga,
  assertCanVerify,
  assertNotSelfApproval,
  resolveWritableLga,
  scopedLgas,
  scopedCommunities,
  rankOf,
  andFilters,
};
