'use strict';

const { ZodError } = require('zod');
const ApiError = require('../utils/ApiError');

/**
 * Validates and REPLACES req.body / req.query / req.params with the parsed
 * result, so handlers only ever see coerced, stripped, trusted values.
 *
 *   router.post('/', validate({ body: createFishermanSchema }), controller.create);
 */
function validate(schemas) {
  // Named so it is identifiable in a stack trace and in a router walk.
  return function validateRequest(req, res, next) {
    try {
      for (const source of ['params', 'query', 'body']) {
        const schema = schemas[source];
        if (!schema) continue;
        const parsed = schema.parse(req[source]);
        if (source === 'query') {
          // Express 5 exposes req.query via a getter; define instead of assign.
          Object.defineProperty(req, 'query', { value: parsed, writable: true, configurable: true });
        } else {
          req[source] = parsed;
        }
      }
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        return next(
          ApiError.unprocessable('The submitted data is not valid', {
            details: formatZodIssues(err),
          })
        );
      }
      next(err);
    }
  };
}

/** Flattens Zod issues into `{ field, message, code }` the portal can map to inputs. */
function formatZodIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));
}

module.exports = { validate, formatZodIssues };
