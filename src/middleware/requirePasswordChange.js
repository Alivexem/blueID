'use strict';

const config = require('../config');
const ApiError = require('../utils/ApiError');

/**
 * Temporary-credential containment.
 *
 * An account issued a password it did not choose — the bootstrap administrator,
 * a newly invited officer, anyone an administrator has just reset — carries
 * `mustChangePassword`. Until that flag is cleared the credential is known to
 * somebody other than its holder: it was typed by a colleague, read off a
 * terminal, or sent over WhatsApp. It is a handover token, not a password.
 *
 * So it buys exactly one thing: the right to replace itself. Every other route
 * is refused.
 *
 * WHY THIS IS SERVER-SIDE
 *
 * The flag is also returned in the sign-in response, and a well-behaved portal
 * will redirect on it. That redirect is a courtesy to the user, not a control:
 * it lives in client code, it is skipped by curl, and it is absent from the
 * field app until someone implements it. Leaving enforcement there would mean a
 * shared bootstrap password quietly conferred full SUPER_ADMIN access to anyone
 * who ignored a JSON field — which is the whole risk the flag exists to
 * contain. The check therefore sits inside `authenticate`, where no route can
 * be mounted around it.
 */

/**
 * The only routes reachable while the flag is set.
 *
 * `change-password` is the way out. The sign-out pair is here so somebody who
 * cannot complete the change is not trapped in a session they are unable to
 * end, and `GET /users/me` so the portal can render "Welcome, Ada — choose a
 * password" instead of a bare error screen. Nothing on this list reads
 * fisherman data or alters the register.
 */
const ALLOWED_ROUTES = Object.freeze([
  'POST /auth/change-password',
  'POST /auth/logout',
  'POST /auth/logout-all',
  'GET /auth/sessions',
  'GET /users/me',
]);

const allowed = new Set(ALLOWED_ROUTES);

/**
 * `METHOD /path`, with the API prefix and any query string removed, so the
 * allowlist above does not have to encode the deployment's mount point.
 */
function routeKey(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  const prefix = config.app.apiPrefix || '';
  const relative = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const normalised = relative.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
  return `${String(req.method || '').toUpperCase()} ${normalised}`;
}

/**
 * Throws unless the request is one a temporary-password holder may make.
 * Called from `authenticate` once the user has been resolved.
 */
function assertPasswordChanged(user, req) {
  if (!user || user.mustChangePassword !== true) return;
  if (allowed.has(routeKey(req))) return;

  throw new ApiError(403, 'Set your own password before using the system', {
    code: 'PASSWORD_CHANGE_REQUIRED',
    details: {
      reason:
        'This account is still using a password it was issued rather than one it chose.',
      changePasswordEndpoint: `${config.app.apiPrefix}/auth/change-password`,
    },
  });
}

module.exports = { assertPasswordChanged, routeKey, ALLOWED_ROUTES };
