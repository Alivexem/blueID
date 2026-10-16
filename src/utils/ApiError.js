'use strict';

/**
 * Operational error carrying an HTTP status and a stable machine-readable
 * `code`. Clients (especially the offline field app, which must decide whether
 * to retry or park a record) branch on `code`, never on the message text.
 */
class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = options.code || defaultCodeFor(statusCode);
    this.details = options.details;
    this.isOperational = options.isOperational !== false;
    if (options.cause) this.cause = options.cause;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', options) {
    return new ApiError(400, message, { code: 'BAD_REQUEST', ...options });
  }

  static unauthorized(message = 'Authentication required', options) {
    return new ApiError(401, message, { code: 'UNAUTHENTICATED', ...options });
  }

  static forbidden(message = 'You do not have permission to perform this action', options) {
    return new ApiError(403, message, { code: 'FORBIDDEN', ...options });
  }

  static notFound(message = 'Resource not found', options) {
    return new ApiError(404, message, { code: 'NOT_FOUND', ...options });
  }

  static conflict(message = 'Resource conflict', options) {
    return new ApiError(409, message, { code: 'CONFLICT', ...options });
  }

  static unprocessable(message = 'Validation failed', options) {
    return new ApiError(422, message, { code: 'VALIDATION_ERROR', ...options });
  }

  static tooMany(message = 'Too many requests', options) {
    return new ApiError(429, message, { code: 'RATE_LIMITED', ...options });
  }

  static internal(message = 'Internal server error', options) {
    return new ApiError(500, message, { code: 'INTERNAL_ERROR', isOperational: false, ...options });
  }

  static unavailable(message = 'Service temporarily unavailable', options) {
    return new ApiError(503, message, { code: 'SERVICE_UNAVAILABLE', ...options });
  }
}

function defaultCodeFor(statusCode) {
  const map = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHENTICATED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    422: 'VALIDATION_ERROR',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR',
    503: 'SERVICE_UNAVAILABLE',
  };
  return map[statusCode] || 'ERROR';
}

module.exports = ApiError;
