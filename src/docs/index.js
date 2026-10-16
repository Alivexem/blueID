'use strict';

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const spec = require('./openapi');
const config = require('../config');

/**
 * Interactive API documentation.
 *
 * Served at /docs with the raw spec at /docs.json, so a client generator can
 * consume it directly.
 *
 * The spec describes the public contract and contains no secrets, but it does
 * map the whole attack surface, so in production it sits behind the same
 * probe key as the detailed health endpoint. Set DOCS_PUBLIC=true to publish
 * it openly, which is reasonable for a staging environment the frontend team
 * works against.
 */
const router = express.Router();

function docsGuard(req, res, next) {
  if (!config.isProduction || config.app.docsPublic) return next();

  const key = req.get('x-probe-key') || req.query.key;
  const { constantTimeEquals } = require('../middleware/authenticate');

  if (config.app.probeKey && key && constantTimeEquals(key, config.app.probeKey)) {
    return next();
  }
  return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

router.use(docsGuard);

/** Machine-readable spec, for client generation. */
router.get('/json', (req, res) => res.json(spec));

router.use(
  '/',
  swaggerUi.serve,
  swaggerUi.setup(spec, {
    customSiteTitle: 'Blue ID API',
    swaggerOptions: {
      docExpansion: 'none',
      defaultModelsExpandDepth: 1,
      displayRequestDuration: true,
      filter: true,
      tagsSorter: 'alpha',
    },
  })
);

module.exports = router;
