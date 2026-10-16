'use strict';

/**
 * Safe MongoDB filter composition.
 *
 * This module exists because of a real defect: authorization scope is returned
 * as a filter fragment (often `{ $or: [...] }`), and a later `filter.$or = ...`
 * from a search clause silently REPLACED it — dropping the scope and exposing
 * the whole register. Spreading two filters that share a top-level operator is
 * never safe.
 *
 * Always combine filters through `andFilters`, which pushes conflicting keys
 * into an explicit `$and` instead of overwriting them.
 */

/** Keys that must never be merged by assignment. */
const LOGICAL_OPERATORS = new Set(['$or', '$and', '$nor', '$text', '$expr']);

const isPlainObject = (value) =>
  value != null && typeof value === 'object' && !Array.isArray(value);

/**
 * Combines any number of filter fragments.
 *
 *   andFilters(scopeFilter, { status: 'ACTIVE' }, searchFilter)
 *
 * Non-conflicting scalar keys are merged flat (so indexes are still used and
 * the query stays readable). Anything that would collide — a repeated key with
 * a different value, or a logical operator present in more than one fragment —
 * is moved into `$and`, which preserves every condition.
 */
function andFilters(...fragments) {
  const parts = fragments.filter((f) => isPlainObject(f) && Object.keys(f).length > 0);

  if (parts.length === 0) return {};
  if (parts.length === 1) return { ...parts[0] };

  const merged = {};
  const conflicts = [];

  for (const fragment of parts) {
    const spillover = {};

    for (const [key, value] of Object.entries(fragment)) {
      const collides =
        Object.prototype.hasOwnProperty.call(merged, key) || LOGICAL_OPERATORS.has(key);

      if (!collides) {
        merged[key] = value;
      } else if (key === '$and' && Array.isArray(value)) {
        // Flatten nested $and rather than nesting it again.
        conflicts.push(...value);
      } else {
        spillover[key] = value;
      }
    }

    if (Object.keys(spillover).length) conflicts.push(spillover);
  }

  if (!conflicts.length) return merged;

  // Anything already merged stays at the top level; conflicts go into $and.
  const existingAnd = Array.isArray(merged.$and) ? merged.$and : [];
  delete merged.$and;

  return { ...merged, $and: [...existingAnd, ...conflicts] };
}

/**
 * Builds a filter from an allowlist, so a client can never inject a key or a
 * Mongo operator by naming it in the query string.
 *
 *   pickFilters(req.query, { status: 'status', lga: 'lga' })
 *
 * `mapping` maps a request field to either a document path (string) or a
 * `(value) => fragment | null` builder.
 */
function pickFilters(source = {}, mapping = {}) {
  const filter = {};

  for (const [queryKey, target] of Object.entries(mapping)) {
    const value = source[queryKey];
    if (value === undefined || value === null || value === '') continue;

    if (typeof target === 'function') {
      const fragment = target(value);
      if (fragment) Object.assign(filter, fragment);
    } else {
      filter[target] = value;
    }
  }

  return filter;
}

/**
 * Resolves a sort string against an allowlist of sortable fields.
 * An unlisted field falls back to the default rather than being passed
 * through, which keeps queries on indexes and blocks sort-based probing.
 */
function resolveSort(requested, allowed = [], fallback = { createdAt: -1 }) {
  if (!requested || typeof requested !== 'string') return fallback;

  const descending = requested.startsWith('-');
  const field = descending ? requested.slice(1) : requested;

  if (!allowed.includes(field)) return fallback;
  return { [field]: descending ? -1 : 1 };
}

/**
 * Escapes a value for safe use inside a RegExp.
 * Only ever used for prefix/contains search on short, bounded fields.
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Rejects any value that is not a primitive before it reaches a query.
 * Zod already enforces this at the edge; this is the second line of defence
 * for internally-built filters (NoSQL operator injection).
 */
function assertScalar(value, field = 'value') {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || value instanceof Date) {
    return value;
  }
  const ApiError = require('./ApiError');
  throw ApiError.badRequest(`Invalid value supplied for ${field}`, {
    code: 'INVALID_FILTER_VALUE',
  });
}

module.exports = { andFilters, pickFilters, resolveSort, escapeRegex, assertScalar };
