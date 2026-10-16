'use strict';

/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * middleware instead of becoming an unhandled rejection.
 *
 *   router.get('/', asyncHandler(async (req, res) => { ... }));
 */
const asyncHandler = (fn) =>
  // The wrapper borrows the handler's name, so middleware stays identifiable
  // in stack traces and when walking the router.
  Object.defineProperty(
    function asyncHandlerWrapper(req, res, next) {
      Promise.resolve(fn(req, res, next)).catch(next);
    },
    'name',
    { value: fn.name || 'asyncHandlerWrapper', configurable: true }
  );

module.exports = asyncHandler;
