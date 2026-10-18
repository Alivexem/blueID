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

module.exports = async (req, res) => {
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
