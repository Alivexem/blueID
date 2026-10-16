'use strict';

const crypto = require('node:crypto');
const pinoHttp = require('pino-http');
const logger = require('../config/logger');

/**
 * Assigns every request a stable id, echoes it back on the response and binds
 * it to the logger. The id also lands on audit records, which is what lets an
 * auditor tie a database change to the exact HTTP call that caused it.
 */
function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = incoming && /^[\w.-]{8,128}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.id);
  next();
}

const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => req.id,
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    if (req.url === '/health' || req.url.endsWith('/health/live')) return 'silent';
    return 'info';
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  serializers: {
    req(req) {
      return {
        id: req.id,
        method: req.method,
        url: req.url,
        deviceId: req.headers['x-device-id'],
      };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});

module.exports = { requestId, httpLogger };
