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

/** Name of the short-lived cookie that carries the docs grant. */
const DOCS_COOKIE = 'blueid_docs';
const DOCS_COOKIE_TTL_SECONDS = 30 * 60;

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Guards the documentation in production.
 *
 * THE COOKIE IS NOT A CONVENIENCE, IT IS THE FIX.
 *
 * Swagger UI is an HTML page that then fetches its own stylesheet and
 * scripts. A browser sends no `?key=` on those follow-up requests, so they
 * were refused and the page rendered blank — the HTML arrived, nothing else
 * did, and there was no error to see because a 404 on a stylesheet is
 * silent.
 *
 * Letting static assets through unguarded is not an option: Swagger
 * embeds the entire specification inside `swagger-ui-init.js`, so
 * exempting `.js` would publish exactly what the guard exists to withhold.
 *
 * So a request that proves the key once is granted a short-lived cookie,
 * and the asset requests that follow carry it. `httpOnly` keeps it away
 * from page scripts, `sameSite=strict` keeps another site from using it,
 * and the path confines it to the docs.
 */
function docsGuard(req, res, next) {
  if (!config.isProduction || config.app.docsPublic) return next();

  const { constantTimeEquals } = require('../middleware/authenticate');
  const refuse = () =>
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });

  if (!config.app.probeKey) return refuse();

  const presented = req.get('x-probe-key') || req.query.key;
  if (presented && constantTimeEquals(presented, config.app.probeKey)) {
    res.cookie?.(DOCS_COOKIE, config.app.probeKey, {
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      maxAge: DOCS_COOKIE_TTL_SECONDS * 1000,
      path: '/docs',
    });
    return next();
  }

  const cookie = readCookie(req, DOCS_COOKIE);
  if (cookie && constantTimeEquals(cookie, config.app.probeKey)) return next();

  return refuse();
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
