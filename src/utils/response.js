'use strict';

/**
 * One response envelope for the whole API, so the portal and the field app can
 * parse every reply the same way.
 *
 *   { success, data, meta?, message?, requestId }
 *   { success: false, error: { code, message, details? }, requestId }
 */

function ok(res, data, { message, meta, status = 200 } = {}) {
  return res.status(status).json({
    success: true,
    ...(message ? { message } : {}),
    data,
    ...(meta ? { meta } : {}),
    requestId: res.req?.id,
  });
}

function created(res, data, options = {}) {
  return ok(res, data, { status: 201, ...options });
}

function accepted(res, data, options = {}) {
  return ok(res, data, { status: 202, ...options });
}

function noContent(res) {
  return res.status(204).send();
}

/**
 * Paginated list. `pagination` comes from utils/pagination.js so page/limit
 * semantics never drift between endpoints.
 */
function paginated(res, items, pagination, extraMeta = {}) {
  return ok(res, items, { meta: { pagination, ...extraMeta } });
}

module.exports = { ok, created, accepted, noContent, paginated };
