'use strict';

const pino = require('pino');
const config = require('./index');

/**
 * Structured logger. Personal data (the system holds NINs, phone numbers and
 * next-of-kin details) is redacted before it can reach a log sink.
 */
const redact = {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["x-api-key"]',
    'req.headers["x-device-secret"]',
    'req.body.nin',
    'req.body.phone',
    'req.body.nextOfKin',
    'req.body.deviceSecret',
    'req.query.deviceSecret',
    '*.nin',
    '*.password',
    '*.token',
    '*.secret',
    '*.secretHash',
    '*.syncSecret',
    '*.verificationToken',
    // A signed media URL grants access to a citizen's photograph for as long
    // as it is valid, so it is a credential and must not reach a log sink.
    '*.photo.url',
    '*.signedUrl',
    // Explicit paths: the `*.token` wildcard matches only one level deep, so
    // nested credentials like config.redis.token would otherwise pass through.
    'config.auth.secret',
    'config.auth.serviceApiKey',
    'config.security.fieldEncryptionKey',
    'config.redis.token',
    'config.redis.url',
    'config.brevo.apiKey',
    'config.cloudinary.apiSecret',
    'config.firebase.privateKey',
    'config.blueId.qrSecret',
    '*.privateKey',
    '*.apiKey',
  ],
  censor: '[redacted]',
};

const logger = pino({
  level: config.log.level,
  redact,
  base: { service: 'blueid-api', env: config.env },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(config.isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,env' },
        },
      }),
});

module.exports = logger;
