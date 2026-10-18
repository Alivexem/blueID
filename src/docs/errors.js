'use strict';

/**
 * The error-code reference.
 *
 * Clients branch on `error.code`, never on `error.message` — the message is
 * written for a person and may be reworded; the code is the contract. So
 * every code the API can return needs to be here, and
 * test/docs.test.js fails the build if one is missing.
 *
 * Grouped by what the caller should DO about it, because that is the
 * decision a client is actually making: retry, re-authenticate, show the
 * user something, or give up.
 */

/** Sign in again. The credential is gone or was never valid. */
const AUTHENTICATION = [
  ['TOKEN_MISSING', 401, 'No `Authorization: Bearer` header was sent.'],
  ['TOKEN_INVALID', 401, 'The token is not one this service issued, or it has been tampered with.'],
  ['TOKEN_EXPIRED', 401, 'The access token has expired. Call `/auth/refresh` and retry once.'],
  ['TOKEN_NOT_ACTIVE', 401, 'The token carries a `nbf` in the future — usually a clock skew on the device.'],
  ['TOKEN_NO_SUBJECT', 401, 'The token has no subject claim, so it identifies nobody.'],
  ['WRONG_TOKEN_TYPE', 401, 'A refresh token was sent where an access token belongs. They are not interchangeable.'],
  ['SESSION_REVOKED', 401, 'The session behind this token was ended — by a sign-out, a password change, or a suspension. Sign in again.'],
  ['REFRESH_TOKEN_INVALID', 401, 'The refresh token is unknown, already used, or revoked. **A reused token revokes its whole family**, so this can also mean another client refreshed and the session was ended as a suspected theft.'],
  ['INVALID_CREDENTIALS', 401, 'Wrong password, or no such account — deliberately indistinguishable.'],
  ['ACCOUNT_NOT_FOUND', 401, 'The account the token names no longer exists.'],
  ['WEAK_PASSWORD', 422, 'The password fails the policy. `details` lists every reason at once, so the user fixes them in one attempt rather than discovering them one by one.'],
  ['RESET_TOKEN_INVALID', 400, 'The reset link is unknown, already used, or past its expiry. Single use by design.'],
  ['SERVICE_KEY_INVALID', 401, 'The `x-api-key` for a machine-to-machine integration is wrong.'],
];

/** Authenticated, but not allowed. Do not retry; the answer will not change. */
const AUTHORIZATION = [
  ['MISSING_PERMISSION', 403, 'The role does not hold the capability this route requires.'],
  ['PASSWORD_CHANGE_REQUIRED', 403, 'The account is still on a password it was issued rather than chose. Only the change-password, sign-out and own-profile routes work until it is replaced.'],
  ['ACCOUNT_INACTIVE', 403, 'Suspended or disabled. Returned on sign-in too, even with the correct password, so the holder knows why.'],
  ['ACCOUNT_PENDING', 403, 'Created but not yet approved by an administrator.'],
  ['ACCOUNT_REMOVED', 403, 'The account has been deleted.'],
  ['ACCOUNT_LOCKED', 423, 'Too many consecutive failures on this account. Wait; it clears itself.'],
  ['AUTH_FAILURES_EXCEEDED', 429, 'Too many failed authentications from this source. Wait; `Retry-After` says how long.'],
  ['RATE_LIMITED', 429, 'Too many requests. Respect `Retry-After`.'],
  ['SELF_APPROVAL_FORBIDDEN', 403, 'You cannot approve or verify a record you submitted yourself.'],
  ['SERVICE_READ_ONLY', 403, 'Service credentials are read-only; this route writes.'],
  ['EMAIL_NOT_VERIFIED', 403, 'Only in external-identity modes: the provider has not verified the address.'],
  ['USER_NOT_PROVISIONED', 403, 'Only in external-identity modes: no local account is linked to this login.'],
];

/** The request was understood but cannot be carried out. Show the user why. */
const BUSINESS_RULES = [
  ['NOT_FOUND', 404, 'No such record — **or** one outside your scope. The two are deliberately the same answer, so an id cannot be used to probe for records you may not see.'],
  ['VALIDATION_ERROR', 422, 'Field-level problems; `details` lists them.'],
  ['DUPLICATE_KEY', 409, 'A unique value is already taken.'],
  ['STALE_UPDATE', 409, 'Someone changed this record since you loaded it. Reload and retry.'],
  ['ALREADY_VERIFIED', 409, 'A Blue ID has already been issued — possibly by someone else a moment ago.'],
  ['DUPLICATE_REVIEW_PENDING', 409, 'An unresolved duplicate flag blocks verification. Resolve it first; this is what stops a duplicate entering the benefit stream.'],
  ['INVALID_STATUS_TRANSITION', 409, 'That status cannot follow the current one. The lifecycle is a state machine: a deceased record cannot become active again, for example.'],
  ['NOT_VERIFIED', 400, 'The action needs a verified record, and no Blue ID has been issued.'],
  ['PHOTO_REQUIRED', 400, 'A passport photograph must be attached before a Blue ID can be issued.'],
  ['BLUE_ID_NOT_ISSUED', 400, 'A QR code cannot exist before the Blue ID it encodes.'],
  ['NO_VERIFICATION_TOKEN', 400, 'The record has no card token yet — verify it first.'],
  ['BLUE_ID_REQUIRED', 400, 'A benefit can only be recorded against a verified fisherman.'],
  ['INVALID_IDENTIFIER', 400, 'The id is not a well-formed identifier.'],
  ['INVALID_FILTER_VALUE', 400, 'A query filter holds a value the field cannot take.'],
  ['PAGINATION_TOO_DEEP', 400, 'That page is too far in. Narrow the filters, or use an export.'],
  ['EMAIL_TAKEN', 409, 'An account already exists with that address.'],
];

/** Programmes and benefit allocation. */
const PROGRAMMES = [
  ['ALREADY_ALLOCATED', 409, 'This person already holds a live allocation from this programme. The rule that one benefit is issued once per person per programme.'],
  ['PROGRAMME_FULL', 409, 'The beneficiary target has been reached.'],
  ['PROGRAMME_NOT_OPEN', 409, 'The programme is in draft, closed or archived.'],
  ['PROGRAMME_HAS_ALLOCATIONS', 409, 'Allocations exist, so the programme cannot be deleted — archive it.'],
  ['NOT_ELIGIBLE', 422, 'The fisherman does not meet the programme criteria.'],
  ['BENEFICIARY_NOT_ELIGIBLE', 422, 'The named beneficiary fails this programme\'s eligibility rules — deceased, suspended, wrong LGA, or already served.'],
  ['ELIGIBILITY_LOCKED', 409, 'Criteria cannot change once allocations have been made against them.'],
];

/** Communities, cooperatives and assets. */
const REGISTERS = [
  ['COMMUNITY_EXISTS', 409, 'A community of that name already exists in that LGA.'],
  ['COMMUNITY_IN_USE', 409, 'Fishermen are registered there; deactivate rather than remove.'],
  ['COMMUNITY_LGA_MISMATCH', 400, 'The community does not belong to the LGA given.'],
  ['UNKNOWN_COMMUNITY', 400, 'No such community.'],
  ['UNKNOWN_LGA', 400, 'Not one of the 18 Local Government Area codes.'],
  ['COOPERATIVE_IN_USE', 409, 'The society still has members; deactivate rather than remove.'],
  ['ALREADY_A_MEMBER', 409, 'The fisherman already belongs to another cooperative.'],
  ['ASSET_ALREADY_REGISTERED', 409, 'That registration number or serial is already on file against another owner — a strong signal of a re-registration attempt.'],
  ['OWNER_NOT_FOUND', 400, 'The fisherman this asset belongs to could not be found.'],
  ['OWNER_UNRESOLVED', 400, 'The synced record does not say which fisherman it belongs to.'],
];

/** Offline sync and field devices. */
const SYNC = [
  ['DEVICE_REQUIRED', 401, 'The route needs an enrolled device. Send `deviceCode` and `deviceSecret` in the body, or the `x-device-id` / `x-device-secret` headers.'],
  ['DEVICE_NOT_REGISTERED', 401, 'That device code is unknown.'],
  ['DEVICE_NOT_ENROLLED', 401, 'The device has no active enrolment. Re-enrol it. **Note:** this and the two codes above arrive as 401 even though the user\'s own token is fine — do not let a blanket 401 interceptor sign the officer out, because refreshing their token cannot fix a device problem.'],
  ['DEVICE_NOT_ACTIVE', 403, 'The device is suspended or revoked. Takes effect on the next request, not when a token expires.'],
  ['DEVICE_SECRET_INVALID', 401, 'The device secret does not match.'],
  ['DEVICE_CODE_TAKEN', 409, 'Another device already uses that code.'],
  ['SYNC_IN_PROGRESS', 409, 'Another push from this device is still running. Wait rather than retrying immediately.'],
  ['BATCH_IN_PROGRESS', 409, 'This batch is still being processed. Poll its status; do not resend.'],
  ['BATCH_TOO_LARGE', 400, 'Split the batch. The limit is `SYNC_MAX_BATCH_SIZE` records.'],
  ['RECORD_INVALID', 422, 'A record inside the batch failed validation. The batch still completes; the payload is kept so it can be corrected rather than lost.'],
  ['UNSUPPORTED_ENTITY', 400, 'The batch names an entity type this endpoint does not accept.'],
];

/** Uploads and media. */
const MEDIA = [
  ['INVALID_IMAGE_CONTENT', 400, 'The bytes are not a recognised image, whatever the filename or content type said. Checked by magic number.'],
  ['MEDIA_TYPE_MISMATCH', 400, 'The declared content type does not match the actual bytes.'],
  ['UNSUPPORTED_MEDIA_TYPE', 400, 'That image format is not accepted.'],
  ['MEDIA_UNAVAILABLE', 503, 'Media storage is not configured on this instance, so nothing can be uploaded.'],
  ['PAYLOAD_TOO_LARGE', 413, 'The body exceeds `MAX_UPLOAD_SIZE_MB`.'],
];

/** Transport and server faults. Retrying may help. */
const TRANSPORT = [
  ['MALFORMED_JSON', 400, 'The body is not valid JSON.'],
  ['BAD_REQUEST', 400, 'Generic malformed request.'],
  ['UNAUTHENTICATED', 401, 'Generic authentication failure, where no more specific code applies.'],
  ['FORBIDDEN', 403, 'Generic refusal, where no more specific code applies.'],
  ['ROUTE_NOT_FOUND', 404, 'No such endpoint. Check the method and the `/api/v1` prefix.'],
  ['CONFLICT', 409, 'Generic conflict.'],
  ['DATABASE_UNAVAILABLE', 503, 'The database is unreachable. Retry with backoff.'],
  ['SERVICE_UNAVAILABLE', 503, 'A dependency is unavailable.'],
  ['INTERNAL_ERROR', 500, 'Unexpected fault. `requestId` in the body ties it to the server log.'],
  ['PASSWORD_UNCHANGED', 400, 'The new password is the same as the current one.'],
];

const GROUPS = [
  ['Sign in again', AUTHENTICATION],
  ['Not permitted — do not retry', AUTHORIZATION],
  ['Rule or state prevents it', BUSINESS_RULES],
  ['Programmes and benefits', PROGRAMMES],
  ['Communities, cooperatives, assets', REGISTERS],
  ['Offline sync and devices', SYNC],
  ['Uploads', MEDIA],
  ['Transport and server', TRANSPORT],
];

/** Every code, for the coverage test. */
const ALL_CODES = GROUPS.flatMap(([, rows]) => rows.map(([code]) => code));

/** Rendered as markdown for the OpenAPI description. */
function toMarkdown() {
  const sections = GROUPS.map(([heading, rows]) => {
    const body = rows
      .map(([code, status, meaning]) => `| \`${code}\` | ${status} | ${meaning} |`)
      .join('\n');
    return `#### ${heading}\n\n| Code | Status | Meaning |\n|---|---|---|\n${body}`;
  });

  return [
    '### Error codes',
    '',
    'Branch on `error.code`, never on `error.message`: the message is written for a person and may be reworded, the code is the contract.',
    '',
    ...sections,
  ].join('\n\n');
}

module.exports = { GROUPS, ALL_CODES, toMarkdown };
