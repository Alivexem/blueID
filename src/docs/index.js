'use strict';

const express = require('express');
const spec = require('./openapi');
const config = require('../config');

/**
 * Interactive API documentation.
 *
 * Served at /docs with the raw spec at /docs/json, so a client generator can
 * consume it directly.
 *
 * WHY THIS DOES NOT USE swagger-ui-express
 *
 * It did, and the page rendered blank in production. `swagger-ui-express`
 * serves Swagger's stylesheet and scripts with `express.static`, pointed at
 * a path it resolves at runtime from inside `node_modules`. Vercel's file
 * tracer follows `require` calls, not runtime path resolution, so those
 * 1.5MB of assets were never included in the deployed function — and
 * because the HTML handler matches any path under /docs, every asset
 * request returned the HTML page with a `text/html` content type. The
 * browser refused to execute a stylesheet as a script and showed nothing.
 * A made-up filename returned the same 200, which is how it was found.
 *
 * So the page is served from here and loads Swagger UI from a CDN at a
 * pinned version. Nothing depends on files surviving a bundler, which is
 * the property that was missing.
 *
 * THE SPEC IS GUARDED, THE VIEWER IS NOT
 *
 * Swagger UI itself is public software; there is nothing to protect in it.
 * The specification is what maps the attack surface, so in production
 * `/docs/json` sits behind the same probe key as the detailed health
 * endpoint. The page passes the key through to its own spec request, so one
 * URL is all a reader needs. Set DOCS_PUBLIC=true to publish openly, which
 * is reasonable for a deployment the frontend team works against.
 */
const router = express.Router();

/** Pinned. An unpinned CDN URL is someone else's deploy in your page. */
const SWAGGER_VERSION = '5.33.3';
const CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_VERSION}`;

/**
 * The CSP source is the CDN ORIGIN, not the pinned path.
 *
 * A source expression carrying a path is matched by the spec as follows: a
 * path ending in `/` is a prefix, and a path NOT ending in `/` must match
 * the resource exactly. `…/swagger-ui-dist@5.33.3` therefore permitted
 * precisely one URL — that bare path — and blocked every file beneath it,
 * which is every file the page actually loads.
 *
 * An origin with no path has no such trap. The version stays pinned where
 * it matters, in the URLs below; the policy's job here is to name a host
 * the page may load from, and it should say exactly that.
 */
const CDN_ORIGIN = 'https://cdn.jsdelivr.net';

function docsGuard(req, res, next) {
  if (!config.isProduction || config.app.docsPublic) return next();

  const { constantTimeEquals } = require('../middleware/authenticate');
  const presented = req.get('x-probe-key') || req.query.key;

  if (config.app.probeKey && presented && constantTimeEquals(presented, config.app.probeKey)) {
    return next();
  }

  /**
   * 404 rather than 401: a 403 would confirm that documentation exists at
   * this address, which is a small invitation to keep trying.
   */
  return res
    .status(404)
    .json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } });
}

router.use(docsGuard);

/** Machine-readable spec, for client generation. */
router.get('/json', (req, res) => res.json(spec));

/**
 * The viewer.
 *
 * Content-Security-Policy is set per response rather than relying on the
 * application-wide one, which allows scripts only from 'self' and would
 * block the CDN. It is narrowed to exactly what this page needs: scripts
 * and styles from the pinned CDN, and spec requests to this origin.
 */
router.get('/', (req, res) => {
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  const specUrl = `./json${key ? `?key=${encodeURIComponent(key)}` : ''}`;

  /**
   * `-elem` variants are set explicitly as well as the fallbacks. A browser
   * falls back from `script-src-elem` to `script-src`, and says so in the
   * console, which makes a path problem read like a directive problem.
   * Naming both removes that ambiguity for whoever debugs this next.
   */
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'self' ${CDN_ORIGIN} 'unsafe-inline'`,
      `script-src-elem 'self' ${CDN_ORIGIN} 'unsafe-inline'`,
      `style-src 'self' ${CDN_ORIGIN} 'unsafe-inline'`,
      `style-src-elem 'self' ${CDN_ORIGIN} 'unsafe-inline'`,
      `img-src 'self' data: ${CDN_ORIGIN}`,
      `font-src 'self' data: ${CDN_ORIGIN}`,
      "connect-src 'self'",
      "base-uri 'self'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');

  res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blue ID API</title>
  <link rel="stylesheet" href="${CDN}/swagger-ui.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger"></div>
  <script src="${CDN}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script src="${CDN}/swagger-ui-standalone-preset.js" crossorigin="anonymous"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: ${JSON.stringify(specUrl)},
      dom_id: '#swagger',
      deepLinking: true,
      docExpansion: 'none',
      defaultModelsExpandDepth: 1,
      displayRequestDuration: true,
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'BaseLayout',
    });
  </script>
</body>
</html>`);
});

module.exports = router;
