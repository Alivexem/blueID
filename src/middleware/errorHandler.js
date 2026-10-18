'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../config/logger');
const ApiError = require('../utils/ApiError');

/** 404 for anything the router did not match. */
function notFound(req, res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`, { code: 'ROUTE_NOT_FOUND' }));
}

/**
 * Translates driver/ODM errors into ApiError so the client sees one shape, and
 * so a Mongo duplicate-key error reads as a useful conflict instead of E11000.
 */
function normalizeError(err) {
  if (err instanceof ApiError) return err;

  if (err instanceof mongoose.Error.ValidationError) {
    return ApiError.unprocessable('The submitted data is not valid', {
      details: Object.values(err.errors).map((e) => ({ field: e.path, message: e.message })),
      cause: err,
    });
  }

  if (err instanceof mongoose.Error.CastError) {
    // The field is named; the rejected value is not echoed back, because it
    // may be a NIN or a phone number the caller mistyped into the wrong field.
    return ApiError.badRequest(`Invalid value for ${err.path}`, {
      code: 'INVALID_IDENTIFIER',
      details: { field: err.path },
      cause: err,
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern || {})[0] || 'field';
    const friendly = {
      blueId: 'That Blue ID has already been issued',
      clientRecordId: 'This record has already been synchronised',
      nin: 'A fisherman with that National Identification Number already exists',
      serialNumber: 'That engine serial number is already registered',
      registrationNumber: 'That boat registration number is already registered',
      email: 'An account with that email address already exists',
    };
    return ApiError.conflict(friendly[field] || `Duplicate value for ${field}`, {
      code: 'DUPLICATE_KEY',
      // The value is withheld: on `nin` or a phone index it would confirm
      // that a specific identifier already exists in the register, which is
      // an enumeration oracle.
      details: { field },
      cause: err,
    });
  }

  /**
   * A stale write: someone else changed the document between our read and our
   * save. Reported as a conflict so the client re-reads and retries, rather
   * than one officer's edit silently overwriting another's.
   */
  if (err instanceof mongoose.Error.VersionError) {
    return ApiError.conflict('This record was changed by someone else — reload and try again', {
      code: 'STALE_UPDATE',
      cause: err,
    });
  }

  /**
   * The database is unreachable. This is a server fault, not a bad request,
   * and it must not read as an opaque 500.
   */
  const dbUnavailable =
    err.name === 'MongoNotConnectedError' ||
    err.name === 'MongooseServerSelectionError' ||
    err.name === 'MongoNetworkError' ||
    /buffering timed out|Client must be connected/i.test(err.message || '');

  if (dbUnavailable) {
    return ApiError.unavailable('The database is temporarily unavailable — please retry shortly', {
      code: 'DATABASE_UNAVAILABLE',
      cause: err,
    });
  }

  if (err.type === 'entity.parse.failed') {
    return ApiError.badRequest('Request body is not valid JSON', { code: 'MALFORMED_JSON' });
  }
  if (err.type === 'entity.too.large') {
    /**
     * 413, not 400. This is the status the condition is named for, it is what
     * body-parser itself reports on the error it raises, and it is what
     * media.service.js already returns for an oversized image — the same
     * `PAYLOAD_TOO_LARGE` code was arriving as 400 here and 413 there, so a
     * client could not branch on either one consistently.
     */
    return new ApiError(413, 'Request body is too large', { code: 'PAYLOAD_TOO_LARGE' });
  }

  // Anything unrecognised is a bug, not an expected condition.
  return new ApiError(err.statusCode || 500, err.message || 'Internal server error', {
    code: err.code && typeof err.code === 'string' ? err.code : 'INTERNAL_ERROR',
    isOperational: false,
    cause: err,
  });
}

/**
 * Records a refused authentication or authorization attempt.
 *
 * Both halves matter. The counter bounds token probing and invitation guessing;
 * the audit entry means a privileged access attempt that was DENIED is still
 * evidence — an audit trail that only records successes cannot show an
 * attempted intrusion.
 *
 * Fire-and-forget: observability must never fail the response.
 */
function recordDeniedAccess(req, error) {
  const { recordAuthFailure } = require('./rateLimiter');
  const auditService = require('../services/audit.service');

  // 401 is "who are you"; 403 is "not you". Only the former is credential
  // probing, so a legitimate user hitting a scope boundary is not throttled.
  if (error.statusCode === 401) {
    recordAuthFailure(req).catch(() => {});
  }

  auditService
    .recordFailure({
      action: error.statusCode === 401 ? 'LOGIN' : 'VIEW_SENSITIVE',
      entity: { type: 'Request', label: `${req.method} ${req.originalUrl}` },
      reason: error.code,
      req,
      metadata: { statusCode: error.statusCode, path: req.path },
    })
    .catch(() => {});
}

// eslint-disable-next-line no-unused-vars -- Express identifies this by arity
function errorHandler(err, req, res, next) {
  const error = normalizeError(err);

  if (error.statusCode === 401 || error.statusCode === 403) {
    recordDeniedAccess(req, error);
  }

  /**
   * Never log a raw error object.
   *
   * A Mongoose ValidationError carries the offending VALUE on every failed
   * path, and a duplicate-key error carries `keyValue` — so logging the error
   * verbatim could write a citizen's NIN or phone number into a log sink that
   * has none of the register's access controls. Only the shape of the failure
   * is kept; the data that caused it stays in the database.
   */
  const safeError = {
    name: error.name,
    message: error.message,
    code: error.code,
    ...(error.isOperational ? {} : { stack: error.stack }),
  };

  const logPayload = {
    err: safeError,
    requestId: req.id,
    userId: req.user?.id,
    route: `${req.method} ${req.originalUrl}`,
    statusCode: error.statusCode,
  };

  if (error.statusCode >= 500) logger.error(logPayload, 'Request failed');
  else logger.warn(logPayload, 'Request rejected');

  // Never leak internals of an unexpected failure to the client.
  const message =
    error.statusCode >= 500 && config.isProduction ? 'Something went wrong on our side' : error.message;

  res.status(error.statusCode).json({
    success: false,
    error: {
      code: error.code,
      message,
      ...(error.details ? { details: error.details } : {}),
      ...(config.isProduction ? {} : { stack: error.stack?.split('\n').slice(0, 5) }),
    },
    requestId: req.id,
  });
}

module.exports = { notFound, errorHandler, normalizeError };
