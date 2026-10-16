'use strict';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 25;

/**
 * Offset pagination for portal tables.
 * Reads `page` / `limit` from a validated query object.
 */
/**
 * Deep offset pagination makes MongoDB walk and discard every skipped
 * document, so a request for page 5,000 is a cheap way to load the database.
 * Past this depth the caller is told to narrow the filter or use a cursor.
 */
const MAX_SKIP = 10_000;

function resolvePagination(query = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requested = Number.parseInt(query.limit, 10) || DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, requested), MAX_LIMIT);
  const skip = (page - 1) * limit;

  if (skip > MAX_SKIP) {
    const ApiError = require('./ApiError');
    throw ApiError.badRequest(
      'That page is too deep to request directly — narrow the filters or export the data instead',
      { code: 'PAGINATION_TOO_DEEP', details: { maxSkip: MAX_SKIP, requestedSkip: skip } }
    );
  }

  return { page, limit, skip };
}

/**
 * `total` may be null when counting was skipped or timed out; `hasNextPage` is
 * then supplied by the caller from the extra row it fetched, so paging still
 * works without a total.
 */
function buildPaginationMeta({ page, limit }, total, hasNextPage) {
  const hasTotal = typeof total === 'number';
  const totalPages = hasTotal && limit > 0 ? Math.ceil(total / limit) : null;

  return {
    page,
    limit,
    total: hasTotal ? total : null,
    totalPages,
    hasNextPage:
      typeof hasNextPage === 'boolean' ? hasNextPage : hasTotal ? page < totalPages : false,
    hasPrevPage: page > 1,
    ...(hasTotal ? {} : { countUnavailable: true }),
  };
}

/**
 * Runs a count + find pair against a Mongoose model and returns both the rows
 * and the meta block. Keeps every list endpoint to a couple of lines.
 */
/** How long a count may run before the page is served without a total. */
const COUNT_TIMEOUT_MS = 2000;

/**
 * Runs a page query.
 *
 * `hasNextPage` comes from fetching one extra row, not from the count. That
 * matters because `countDocuments` traverses the whole matching set, and on
 * the register's busiest endpoint — a text search combined with an
 * enumerator's `$or` scope — that doubled the cost of every request just to
 * render a page number.
 *
 * The total is still produced, but it is bounded by `maxTimeMS`: if counting
 * a very large result set would be slow, the page is served with
 * `total: null` rather than made to wait. Navigation keeps working because
 * `hasNextPage` is independent of it.
 */
async function paginate(model, filter, { page, limit, skip }, options = {}) {
  const { sort = { createdAt: -1 }, select, populate, lean = true, collation, count = true } = options;

  let query = model
    .find(filter)
    .sort(sort)
    .skip(skip)
    // One extra row tells us whether another page exists.
    .limit(limit + 1);

  if (select) query = query.select(select);
  if (populate) query = query.populate(populate);
  if (collation) query = query.collation(collation);
  if (lean) query = query.lean();

  const countPromise = count
    ? model
        .countDocuments(filter)
        .maxTimeMS(COUNT_TIMEOUT_MS)
        .catch(() => null) // too slow to count: serve the page anyway
    : Promise.resolve(null);

  const [rows, total] = await Promise.all([query.exec(), countPromise]);

  const hasNextPage = rows.length > limit;
  const items = hasNextPage ? rows.slice(0, limit) : rows;

  return {
    items,
    pagination: buildPaginationMeta({ page, limit }, total, hasNextPage),
  };
}

/**
 * Keyset pagination for offline sync pulls.
 *
 * Offset paging is unsafe there: a device may page through tens of thousands
 * of records while new ones are written, which silently skips rows. We page on
 * (updatedAt, _id) instead, which is stable under concurrent writes.
 */
function encodeCursor({ updatedAt, id }) {
  return Buffer.from(`${new Date(updatedAt).toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [timestamp, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const updatedAt = new Date(timestamp);
    if (Number.isNaN(updatedAt.getTime()) || !id) return null;
    return { updatedAt, id };
  } catch {
    return null;
  }
}

/** Mongo filter fragment that continues strictly after `cursor`. */
function cursorFilter(cursor) {
  const decoded = decodeCursor(cursor);
  if (!decoded) return {};
  return {
    $or: [
      { updatedAt: { $gt: decoded.updatedAt } },
      { updatedAt: decoded.updatedAt, _id: { $gt: decoded.id } },
    ],
  };
}

const CURSOR_SORT = Object.freeze({ updatedAt: 1, _id: 1 });

module.exports = {
  MAX_LIMIT,
  MAX_SKIP,
  DEFAULT_LIMIT,
  resolvePagination,
  buildPaginationMeta,
  paginate,
  encodeCursor,
  decodeCursor,
  cursorFilter,
  CURSOR_SORT,
};
