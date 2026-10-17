'use strict';

const http = require('node:http');

const app = require('./app');
const config = require('./config');
const logger = require('./config/logger');
const database = require('./config/database');
const workers = require('./workers');

/**
 * Process entry point: connect to MongoDB, start listening, and shut down
 * cleanly.
 *
 * Graceful shutdown matters more than usual here. A field device may be
 * halfway through pushing a day's registrations when a deploy happens; killing
 * the process mid-batch would leave a sync batch stuck in PROCESSING and force
 * the device to retry. Draining in-flight requests before closing lets those
 * batches finish and be acknowledged.
 */

let server;
let shuttingDown = false;

async function start() {
  // Refuses to boot a second instance while the cache, rate limiter and sync
  // lock are per-process. Checked first so the failure is a clear startup
  // error rather than a duplicated allocation months later.
  require('./config/cache').assertSingleInstance();

  await database.connect();

  server = http.createServer(app);

  // Slightly above a typical 60s load-balancer idle timeout, so the balancer
  // closes connections rather than the server dropping them mid-response.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  // Long enough for a large streamed Excel export.
  server.requestTimeout = 300_000;

  await new Promise((resolve) => server.listen(config.app.port, resolve));

  // Background jobs run in-process by default. Claiming is atomic in MongoDB,
  // so this is still correct if the same image is later scaled out or run as a
  // dedicated worker fleet with WORKER_ENABLED=false on the API nodes.
  workers.start();

  logger.info(
    {
      port: config.app.port,
      env: config.env,
      apiPrefix: config.app.apiPrefix,
      authMode: config.auth.mode,
      cache: 'in-process',
      media: config.cloudinary.enabled ? 'cloudinary' : 'disabled',
      email: config.brevo.enabled ? (config.brevo.dryRun ? 'brevo (dry run)' : 'brevo') : 'disabled',
    },
    `${config.app.name} API listening on port ${config.app.port}`
  );

  if (config.auth.mode === 'disabled') {
    logger.warn(
      'AUTH_MODE=disabled — requests are trusted from x-debug-* headers. Never use this outside local development.'
    );
  }
}

async function shutdown(signal, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutting down');

  /**
   * Fail readiness FIRST, then pause before closing.
   *
   * A load balancer needs a moment to notice this instance is draining.
   * Closing the listener immediately would reject requests it had already
   * routed here, turning a routine deploy into user-visible errors for field
   * officers mid-sync.
   */
  require('./modules/health/health.routes').setAcceptingTraffic(false);
  await new Promise((resolve) => setTimeout(resolve, config.isProduction ? 5000 : 0));

  // Force-exit if a hung connection prevents a clean close.
  const forceTimer = setTimeout(() => {
    logger.error('Shutdown timed out after 30s — forcing exit');
    process.exit(1);
  }, 30_000);
  forceTimer.unref();

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('HTTP server closed to new connections');
    }
    // Let in-flight jobs finish; anything unfinished keeps its claim until it
    // expires and is picked up again, so no queued work is lost on deploy.
    await workers.stop();
    await database.disconnect();
    clearTimeout(forceTimer);
    logger.info('Shutdown complete');
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * An unhandled rejection or uncaught exception leaves the process in an
 * unknown state. Log it, then exit so the supervisor restarts cleanly rather
 * than leaving a half-broken instance serving the register.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException', 1);
});

start().catch((err) => {
  logger.fatal({ err }, 'Failed to start the server');
  process.exit(1);
});
