'use strict';

/**
 * Environment loading + validation.
 *
 * Precedence (first match wins, matching the convention most Node tooling uses):
 *   1. real process env (what the host/CI injects)
 *   2. .env.<NODE_ENV>.local
 *   3. .env.local
 *   4. .env
 *
 * The process refuses to boot on an invalid env rather than failing later with
 * a confusing runtime error.
 */

const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');
const { z } = require('zod');

const ROOT = path.resolve(__dirname, '..', '..');
const NODE_ENV = process.env.NODE_ENV || 'development';

for (const file of [`.env.${NODE_ENV}.local`, '.env.local', '.env']) {
  const full = path.join(ROOT, file);
  if (fs.existsSync(full)) {
    // dotenv does not override already-set vars, so earlier files win.
    dotenv.config({ path: full });
  }
}

/** Coerce "true"/"1"/"yes" to boolean. */
const bool = (def) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) =>
      typeof v === 'boolean' ? v : ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())
    );

/** Comma-separated string -> trimmed array. */
const csv = (def = '') =>
  z
    .string()
    .default(def)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );

const int = (def) => z.coerce.number().int().default(def);

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: int(5000),
    API_PREFIX: z.string().default('/api/v1'),
    APP_NAME: z.string().default('Blue ID'),
    APP_BASE_URL: z.string().url().default('http://localhost:5000'),
    WEB_PORTAL_URL: z.string().url().default('http://localhost:3000'),
    CORS_ORIGINS: csv('http://localhost:3000'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: bool(false),
    /**
     * Shared secret that unlocks the detailed readiness body. Without it a
     * probe sees only up/down, because the diagnosis names internal
     * collections, integration state and missing constraints.
     */
    HEALTH_PROBE_KEY: z.string().default(''),
    /** Publish /docs without the probe key (fine for staging). */
    DOCS_PUBLIC: bool(false),

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    MONGODB_MAX_POOL_SIZE: int(20),
    MONGODB_MIN_POOL_SIZE: int(2),

    CACHE_PREFIX: z.string().default('blueid'),
    CACHE_TTL_SECONDS: int(300),
    DASHBOARD_CACHE_TTL_SECONDS: int(120),

    /**
     * `local` — this service owns the credential: it hashes passwords, issues
     * access and refresh tokens, and handles reset. The other modes delegate
     * to an external provider and are kept for compatibility.
     */
    AUTH_MODE: z.enum(['local', 'firebase', 'jwt', 'jwks', 'disabled']).default('local'),
    AUTH_JWT_SECRET: z.string().default(''),
    AUTH_JWKS_URI: z.string().default(''),
    AUTH_JWT_ISSUER: z.string().default(''),
    AUTH_JWT_AUDIENCE: z.string().default(''),
    AUTH_UID_CLAIM: z.string().default('sub'),
    AUTH_EMAIL_CLAIM: z.string().default('email'),
    AUTH_AUTO_PROVISION: bool(false),
    /**
     * An unverified email must never claim an invitation — that is a direct
     * path to taking over a pending administrator account.
     */
    AUTH_REQUIRE_VERIFIED_EMAIL: bool(true),
    AUTH_MAX_FAILURES_PER_WINDOW: int(20),
    /** Access tokens are short-lived because they cannot be withdrawn. */
    AUTH_ACCESS_TOKEN_TTL: z.string().default('15m'),
    /** Refresh tokens are stored, so they can be revoked. */
    AUTH_REFRESH_TOKEN_TTL_DAYS: int(30),
    AUTH_MAX_FAILED_LOGINS: int(8),
    AUTH_LOCKOUT_MINUTES: int(15),
    AUTH_RESET_TOKEN_TTL_MINUTES: int(30),
    SERVICE_API_KEY: z.string().default(''),

    // --- Firebase (identity provider only: no Firestore, no storage) --------
    FIREBASE_PROJECT_ID: z.string().default(''),
    FIREBASE_CLIENT_EMAIL: z.string().default(''),
    FIREBASE_PRIVATE_KEY: z.string().default(''),

    BLUE_ID_PREFIX: z.string().default('CRS'),
    BLUE_ID_SEGMENT: z.string().default('BLU'),
    BLUE_ID_SEQUENCE_PADDING: int(4),
    QR_SIGNING_SECRET: z.string().default(''),
    VERIFICATION_BASE_URL: z.string().default('http://localhost:3000/verify'),

    /** Master secret for application-level field encryption (NIN). */
    FIELD_ENCRYPTION_KEY: z.string().default(''),

    /** Background worker queue. */
    WORKER_ENABLED: bool(true),
    WORKER_CONCURRENCY: int(2),
    WORKER_POLL_INTERVAL_MS: int(2000),
    WORKER_MAX_ATTEMPTS: int(5),
    OUTBOX_BATCH_SIZE: int(50),

    /**
     * Where images live.
     *
     *   cloudinary  the managed service (this deployment's default)
     *   local       the server's own filesystem
     *
     * `local` exists for a deployment that must keep citizen photographs
     * inside Nigeria — NITDA's National Cloud Policy puts identity data in a
     * tier that has to be stored in-country at rest. This build hosts with
     * Cloudinary by the client's decision; switching is one variable, and
     * src/scripts/migrateMedia.js moves the existing images.
     */
    MEDIA_DRIVER: z.enum(['local', 'cloudinary']).default('cloudinary'),
    /** Absolute path, deliberately OUTSIDE the deploy directory. */
    MEDIA_ROOT: z.string().default('/var/lib/blueid/media'),
    /** Signs delivery URLs. Must differ from every other secret. */
    MEDIA_URL_SECRET: z.string().default(''),
    /** Longest edge for a stored asset photograph. */
    MEDIA_MAX_EDGE: int(1024),
    /** JPEG quality for stored images. */
    MEDIA_JPEG_QUALITY: int(82),
    /**
     * Set when nginx fronts the app. Node then authorises the request and
     * hands the file off with X-Accel-Redirect, so image bytes never pass
     * through the event loop. Must match the nginx `internal` location.
     */
    MEDIA_XACCEL_PREFIX: z.string().default(''),

    CLOUDINARY_CLOUD_NAME: z.string().default(''),
    CLOUDINARY_API_KEY: z.string().default(''),
    CLOUDINARY_API_SECRET: z.string().default(''),
    CLOUDINARY_UPLOAD_FOLDER: z.string().default('blueid'),
    CLOUDINARY_UPLOAD_PRESET: z.string().default(''),
    MAX_UPLOAD_SIZE_MB: int(10),

    BREVO_API_KEY: z.string().default(''),
    BREVO_SENDER_EMAIL: z.string().default(''),
    BREVO_SENDER_NAME: z.string().default('Blue ID'),
    BREVO_REPLY_TO: z.string().default(''),
    EMAIL_DRY_RUN: bool(false),

    SYNC_MAX_BATCH_SIZE: int(200),
    SYNC_CONFLICT_STRATEGY: z.enum(['server_wins', 'client_wins', 'manual']).default('server_wins'),
    DUPLICATE_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.72),
    DUPLICATE_AUTO_FLAG: bool(true),

    RATE_LIMIT_WINDOW_MS: int(900000),
    RATE_LIMIT_MAX: int(300),
    SYNC_RATE_LIMIT_MAX: int(60),
  })
  .superRefine((env, ctx) => {
    const isProd = env.NODE_ENV === 'production';

    /**
     * The local driver mints its own delivery URLs, so without a signing
     * secret every stored photograph would be readable by anyone who could
     * guess a path. Refuse to boot rather than serve the register's
     * photographs unprotected.
     */
    if (env.MEDIA_DRIVER === 'local' && !env.MEDIA_URL_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEDIA_URL_SECRET'],
        message:
          'MEDIA_URL_SECRET is required when MEDIA_DRIVER=local — it signs the expiring image URLs',
      });
    }
    if (env.MEDIA_DRIVER === 'local' && env.MEDIA_URL_SECRET && env.MEDIA_URL_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEDIA_URL_SECRET'],
        message: 'MEDIA_URL_SECRET must be at least 32 characters',
      });
    }
    if (isProd && env.MEDIA_DRIVER === 'local' && !env.MEDIA_ROOT.startsWith('/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEDIA_ROOT'],
        message: 'MEDIA_ROOT must be an absolute path in production',
      });
    }

    if (env.AUTH_MODE === 'local' && !env.AUTH_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_JWT_SECRET'],
        message:
          'AUTH_JWT_SECRET is required when AUTH_MODE=local — it signs the access tokens this service issues',
      });
    }
    if (env.AUTH_MODE === 'local' && env.AUTH_JWT_SECRET && env.AUTH_JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_JWT_SECRET'],
        message: 'AUTH_JWT_SECRET must be at least 32 characters',
      });
    }
    if (env.AUTH_MODE === 'jwt' && !env.AUTH_JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_JWT_SECRET'],
        message: 'AUTH_JWT_SECRET is required when AUTH_MODE=jwt',
      });
    }
    if (env.AUTH_MODE === 'firebase' && !env.FIREBASE_PROJECT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIREBASE_PROJECT_ID'],
        message: 'FIREBASE_PROJECT_ID is required when AUTH_MODE=firebase',
      });
    }
    if (env.AUTH_MODE === 'jwks') {
      if (!env.AUTH_JWKS_URI) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_JWKS_URI'],
          message: 'AUTH_JWKS_URI is required when AUTH_MODE=jwks',
        });
      }
      /**
       * Without a pinned issuer and audience, a correctly signed token from
       * any tenant of the same provider verifies — with Google's shared
       * signing keys that is every Firebase project in existence. Both are
       * mandatory in this mode; `firebase` mode pins them automatically.
       */
      if (!env.AUTH_JWT_ISSUER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_JWT_ISSUER'],
          message:
            'AUTH_JWT_ISSUER is required when AUTH_MODE=jwks — without it, tokens from any tenant are accepted',
        });
      }
      if (!env.AUTH_JWT_AUDIENCE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_JWT_AUDIENCE'],
          message:
            'AUTH_JWT_AUDIENCE is required when AUTH_MODE=jwks — without it, tokens for any audience are accepted',
        });
      }
    }
    if (env.AUTH_MODE === 'disabled' && isProd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_MODE'],
        message: 'AUTH_MODE=disabled is forbidden in production',
      });
    }
    /**
     * Auto-provisioning turns anyone who can sign in to the identity provider
     * into a row in `users`. In production, officers are invited.
     */
    if (isProd && env.AUTH_AUTO_PROVISION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_AUTO_PROVISION'],
        message:
          'AUTH_AUTO_PROVISION must be false in production — provision officers by invitation instead',
      });
    }
    if (isProd && !env.AUTH_REQUIRE_VERIFIED_EMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_REQUIRE_VERIFIED_EMAIL'],
        message:
          'AUTH_REQUIRE_VERIFIED_EMAIL must stay true in production — an unverified email could claim an invitation',
      });
    }
    if (isProd && !env.QR_SIGNING_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['QR_SIGNING_SECRET'],
        message: 'QR_SIGNING_SECRET is required in production (Blue ID QR codes are signed)',
      });
    }
    if (isProd && env.FIELD_ENCRYPTION_KEY.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIELD_ENCRYPTION_KEY'],
        message:
          'FIELD_ENCRYPTION_KEY (32+ chars) is required in production — the NIN is encrypted at rest',
      });
    }
    /**
     * BOTH halves are required. Validating only the URL let a production
     * deploy with a missing token boot "successfully" onto the in-process
     * fallback — per-instance rate limits, a per-instance cache and a sync
     * lock that is no longer distributed, with nothing but one startup log
     * line to say so.
     */
    /**
     * The register carries identities, NINs and photographs. An unencrypted
     * database connection would expose all of it to anything on the network
     * path, so production requires TLS — which `mongodb+srv://` implies and
     * `tls=true` states explicitly.
     */
    if (isProd && !/^mongodb\+srv:\/\//.test(env.MONGODB_URI) && !/[?&]tls=true/.test(env.MONGODB_URI)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONGODB_URI'],
        message:
          'The production MongoDB connection must use TLS (mongodb+srv:// or tls=true)',
      });
    }
    if (isProd && env.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'Wildcard CORS origin is forbidden in production',
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Logger depends on config, so this one case writes straight to stderr.
  process.stderr.write(`\nInvalid environment configuration:\n${details}\n\n`);
  process.exit(1);
}

const env = parsed.data;

const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isDevelopment: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',

  app: {
    name: env.APP_NAME,
    port: env.PORT,
    apiPrefix: env.API_PREFIX,
    baseUrl: env.APP_BASE_URL,
    portalUrl: env.WEB_PORTAL_URL,
    corsOrigins: env.CORS_ORIGINS,
    trustProxy: env.TRUST_PROXY,
    probeKey: env.HEALTH_PROBE_KEY,
    docsPublic: env.DOCS_PUBLIC,
  },

  log: { level: env.LOG_LEVEL },

  mongo: {
    uri: env.MONGODB_URI,
    options: {
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      minPoolSize: env.MONGODB_MIN_POOL_SIZE,
      serverSelectionTimeoutMS: 10_000,
      /**
       * Fail fast instead of queuing.
       *
       * With buffering on (the default), a query issued while the database is
       * unreachable sits in memory for 10 seconds and then surfaces as an
       * opaque 500 "buffering timed out". Disabling it turns the same
       * situation into an immediate, honest 503.
       */
      bufferCommands: false,
      socketTimeoutMS: 45_000,
      heartbeatFrequencyMS: 10_000,
      // Writes must reach a majority before they are acknowledged — the
      // register must not lose a registration to a primary failover.
      writeConcern: { w: 'majority', journal: true },
      retryWrites: true,
      retryReads: true,
      /**
       * Index creation is an explicit, reviewed deploy step in production
       * (`npm run db:indexes`), never a side effect of a process starting.
       */
      autoIndex: env.NODE_ENV !== 'production',
    },
  },

  cache: {
    /** In-process only — there is no external cache. See config/cache.js. */
    prefix: env.CACHE_PREFIX,
    ttl: env.CACHE_TTL_SECONDS,
    dashboardTtl: env.DASHBOARD_CACHE_TTL_SECONDS,
  },

  auth: {
    mode: env.AUTH_MODE,
    secret: env.AUTH_JWT_SECRET,
    jwksUri: env.AUTH_JWKS_URI,
    issuer: env.AUTH_JWT_ISSUER || undefined,
    audience: env.AUTH_JWT_AUDIENCE || undefined,
    uidClaim: env.AUTH_UID_CLAIM,
    emailClaim: env.AUTH_EMAIL_CLAIM,
    autoProvision: env.AUTH_AUTO_PROVISION,
    requireVerifiedEmail: env.AUTH_REQUIRE_VERIFIED_EMAIL,
    maxFailuresPerWindow: env.AUTH_MAX_FAILURES_PER_WINDOW,
    accessTokenTtl: env.AUTH_ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: env.AUTH_REFRESH_TOKEN_TTL_DAYS,
    maxFailedLogins: env.AUTH_MAX_FAILED_LOGINS,
    lockoutMinutes: env.AUTH_LOCKOUT_MINUTES,
    resetTokenTtlMinutes: env.AUTH_RESET_TOKEN_TTL_MINUTES,
    serviceApiKey: env.SERVICE_API_KEY,
  },

  firebase: {
    projectId: env.FIREBASE_PROJECT_ID,
    clientEmail: env.FIREBASE_CLIENT_EMAIL,
    privateKey: env.FIREBASE_PRIVATE_KEY,
    // Admin operations (disable/revoke) need a real service account; token
    // verification alone can work from Application Default Credentials.
    enabled: Boolean(env.FIREBASE_PROJECT_ID),
    hasServiceAccount: Boolean(
      env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY
    ),
  },

  blueId: {
    prefix: env.BLUE_ID_PREFIX,
    segment: env.BLUE_ID_SEGMENT,
    padding: env.BLUE_ID_SEQUENCE_PADDING,
    qrSecret: env.QR_SIGNING_SECRET,
    verificationBaseUrl: env.VERIFICATION_BASE_URL,
  },

  security: {
    fieldEncryptionKey: env.FIELD_ENCRYPTION_KEY,
    fieldEncryptionEnabled: Boolean(env.FIELD_ENCRYPTION_KEY),
  },

  worker: {
    enabled: env.WORKER_ENABLED,
    concurrency: env.WORKER_CONCURRENCY,
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    maxAttempts: env.WORKER_MAX_ATTEMPTS,
    outboxBatchSize: env.OUTBOX_BATCH_SIZE,
  },

  media: {
    driver: env.MEDIA_DRIVER,
    root: env.MEDIA_ROOT,
    urlSecret: env.MEDIA_URL_SECRET,
    maxEdge: env.MEDIA_MAX_EDGE,
    jpegQuality: env.MEDIA_JPEG_QUALITY,
    xAccelPrefix: env.MEDIA_XACCEL_PREFIX,
  },

  cloudinary: {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    folder: env.CLOUDINARY_UPLOAD_FOLDER,
    uploadPreset: env.CLOUDINARY_UPLOAD_PRESET,
    enabled: Boolean(
      env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET
    ),
    maxUploadBytes: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  },

  brevo: {
    apiKey: env.BREVO_API_KEY,
    senderEmail: env.BREVO_SENDER_EMAIL,
    senderName: env.BREVO_SENDER_NAME,
    replyTo: env.BREVO_REPLY_TO,
    dryRun: env.EMAIL_DRY_RUN,
    enabled: Boolean(env.BREVO_API_KEY && env.BREVO_SENDER_EMAIL),
  },

  sync: {
    maxBatchSize: env.SYNC_MAX_BATCH_SIZE,
    conflictStrategy: env.SYNC_CONFLICT_STRATEGY,
  },

  duplicates: {
    threshold: env.DUPLICATE_SCORE_THRESHOLD,
    autoFlag: env.DUPLICATE_AUTO_FLAG,
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    syncMax: env.SYNC_RATE_LIMIT_MAX,
  },
};

/**
 * Field encryption derives its keys from the validated config rather than
 * reading process.env directly, so the key is guaranteed to have passed the
 * production check above before any record is written.
 */
require('../utils/fieldCrypto').initialise(config.security.fieldEncryptionKey);

module.exports = config;
