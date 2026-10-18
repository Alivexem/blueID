'use strict';

/**
 * Vercel entry point.
 *
 * Vercel runs this as a serverless function rather than a long-lived
 * server, so there is no `listen()` here — the platform supplies the
 * request and expects the Express app to handle it.
 *
 * WHAT IS DIFFERENT FROM src/server.js
 *
 * `server.js` is the long-running process: it listens on a port, starts the
 * background worker and drains in-flight work on shutdown. Both files stay,
 * because the same application runs in both shapes — a VM uses server.js,
 * Vercel uses this.
 *
 * THE CONNECTION IS CACHED ACROSS INVOCATIONS
 *
 * A warm function instance keeps its module scope between requests, so the
 * database connection is opened once and reused. Opening one per request
 * would exhaust the cluster's connection limit under even light traffic:
 * MongoDB Atlas allows 500, and a handful of concurrent instances each
 * opening a fresh pool gets there quickly.
 *
 * The promise, not the connection, is cached. Two requests arriving on a
 * cold instance at the same moment then await the same connect rather than
 * racing to open two.
 */

const app = require('../src/app');
const database = require('../src/config/database');
const logger = require('../src/config/logger');

let connecting = null;

function ready() {
  if (!connecting) {
    connecting = database.connect().catch((err) => {
      // Clear the cache so the next request retries rather than being
      // handed a permanently rejected promise.
      connecting = null;
      throw err;
    });
  }
  return connecting;
}

/**
 * Let Express parse the query string, as it does everywhere else.
 *
 * Vercel's runtime assigns `req.query` itself, using Node's `querystring`,
 * which has no notion of nesting: `cursors[FISHERMAN]=<cursor>` arrives as a
 * flat key of that literal name and the object the sync API documents is
 * never built.
 *
 * Express would normally parse it with qs, but its query middleware is
 * guarded — `if (!req.query)` in express/lib/middleware/query.js — so a
 * value the platform has already set is deliberately left alone. Vercel's
 * flat parse therefore wins and Express's configured parser never runs.
 *
 * The divergence is what made this dangerous: under every test the real
 * parser is in play, so `limit[a]=1` is a 422 locally and was a 200 on the
 * deployment. The visible symptom was a device sending its pull cursor in
 * bracket form being handed page one again, with `hasMore` still true and
 * nothing in the response to say why it never progressed.
 *
 * Removing the own property lets the middleware do its job, so a deployed
 * request is parsed exactly like a tested one. `qs` is not required directly
 * here on purpose: it is only a transitive dependency of Express, and the
 * point is to use whatever parser the app itself is configured with.
 */
function useExpressQueryParser(req) {
  if (!Object.prototype.hasOwnProperty.call(req, 'query')) return;
  try {
    delete req.query;
  } catch {
    // Non-configurable, which no current runtime does. Leave the flat object
    // in place rather than throwing: a request answered with a query the
    // nested forms cannot reach beats a request that fails outright.
  }
}

module.exports = async (req, res) => {
  useExpressQueryParser(req);

  try {
    await ready();
  } catch (err) {
    logger.error({ err }, 'Database unavailable on a serverless invocation');
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        error: { code: 'DATABASE_UNAVAILABLE', message: 'Service temporarily unavailable' },
      })
    );
    return;
  }

  app(req, res);
};

/** Exported for the test that proves a nested query survives the platform. */
module.exports.useExpressQueryParser = useExpressQueryParser;
