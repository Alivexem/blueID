'use strict';

/**
 * Creates or promotes an administrator account.
 *
 *   npm run create:admin -- --email=ada@crossriverstate.gov.ng \
 *                           --first=Ada --last=Effiom \
 *                           --role=STATE_ADMIN [--lgas=BAK,AKP] \
 *                           [--user-id=superadmin]
 *
 * `--user-id` sets the staff identifier the portal's administration section
 * asks for as "User ID". Sign-in accepts it OR the email address.
 *
 * The account is created WITHOUT an identity-provider subject. It binds to a
 * real login the first time that person authenticates with a matching email,
 * which is what lets an administrator exist before anyone has signed in — the
 * chicken-and-egg problem every new deployment hits.
 */

const database = require('../config/database');
const logger = require('../config/logger');
const User = require('../modules/users/user.model');
const passwordUtil = require('../utils/password');
const { ROLES, ROLE_VALUES, USER_STATUS, LGA_CODES } = require('../config/constants');

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

async function run() {
  const args = parseArgs();

  const email = (args.email || process.env.SEED_ADMIN_EMAIL || '').toLowerCase().trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error('Provide a valid --email=<address>');
  }

  /**
   * The portal's "User ID". Optional, and unique when set — it is a login
   * identifier, so two accounts sharing one would make sign-in ambiguous.
   */
  const userId = (args['user-id'] || args.userId || '').trim() || undefined;
  if (userId && !/^[A-Za-z0-9._-]{3,40}$/.test(userId)) {
    throw new Error('--user-id must be 3-40 characters: letters, digits, dot, underscore or hyphen');
  }

  const role = (args.role || ROLES.STATE_ADMIN).toUpperCase();
  if (!ROLE_VALUES.includes(role)) {
    throw new Error(`--role must be one of: ${ROLE_VALUES.join(', ')}`);
  }

  const lgas = (args.lgas || '')
    .split(',')
    .map((l) => l.trim().toUpperCase())
    .filter(Boolean);

  const unknown = lgas.filter((l) => !LGA_CODES.includes(l));
  if (unknown.length) {
    throw new Error(`Unknown LGA code(s): ${unknown.join(', ')}`);
  }

  await database.connect();

  const existing = await User.findOne({ email });

  /**
   * A password may be supplied with --password; otherwise one is generated
   * and printed ONCE. This is the bootstrap credential for the first Super
   * Administrator, who then creates everyone else.
   */
  const plaintext = args.password || passwordUtil.generateTemporary();
  const generated = !args.password;

  if (args.password) {
    const { valid, problems } = passwordUtil.validate(args.password, { email });
    if (!valid) throw new Error(`Password rejected: ${problems.join('; ')}`);
  }

  if (existing) {
    existing.role = role;
    existing.status = USER_STATUS.ACTIVE;
    if (lgas.length) existing.scope = { ...existing.scope, lgas };
    if (userId) existing.staffId = userId;
    existing.passwordHash = await passwordUtil.hash(plaintext);
    existing.passwordChangedAt = new Date();
    existing.mustChangePassword = generated;
    await existing.save();

    logger.info({ email, role, lgas }, 'Existing account promoted and password reset');
  } else {
    await User.create({
      email,
      firstName: args.first || 'Blue ID',
      lastName: args.last || 'Administrator',
      role,
      status: USER_STATUS.ACTIVE,
      scope: { lgas, communities: [] },
      staffId: userId,
      designation: args.designation,
      passwordHash: await passwordUtil.hash(plaintext),
      passwordChangedAt: new Date(),
      mustChangePassword: generated,
    });

    logger.info({ email, role, lgas: lgas.length ? lgas : 'state-wide' }, 'Administrator created');
  }

  if (generated) {
    // Written to stdout rather than the log, so it is not captured by a log
    // shipper along with everything else.
    process.stdout.write(
      `\n  Email:    ${email}\n` +
        (userId ? `  User ID:  ${userId}\n` : '') +
        `  Password: ${plaintext}\n\n` +
        '  This password is shown once and must be changed at first sign-in.\n' +
        (userId
          ? '  Sign in with either the User ID or the email address.\n\n'
          : '  Sign in with the email address.\n\n')
    );
  }

  await database.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  logger.fatal({ err: err.message }, 'Could not create the administrator');
  await database.disconnect().catch(() => {});
  process.exit(1);
});
