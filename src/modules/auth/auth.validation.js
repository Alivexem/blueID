'use strict';

const { z } = require('zod');
const { MIN_LENGTH } = require('../../utils/password');

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(200);

/**
 * Login deliberately does NOT apply the password policy. Policy belongs on
 * the way in (creation, change, reset); applying it here would tell an
 * attacker which of their guesses were even shaped like a real password.
 */
/**
 * Sign-in accepts EITHER an email address or a user id.
 *
 * The portal's administration section asks for "User ID" and "Password",
 * because that is what an officer is given — a staff identifier, not an
 * address. Accounts created by invitation are identified by email. Both
 * must therefore work, so the field is one identifier and the service
 * decides which it is.
 *
 * `userId` is NOT validated as an email, and not lowercased here: the
 * lookup is case-insensitive at the database, so an officer typing
 * "SuperAdmin" reaches the same account as "superadmin".
 */
const identifier = z
  .string()
  .trim()
  .min(1, 'Enter your user ID or email address')
  .max(200);

const login = z
  .object({
    email: email.optional(),
    userId: identifier.optional(),
    password: z.string().min(1, 'Enter your password').max(200),
  })
  .refine((v) => Boolean(v.email || v.userId), {
    message: 'Provide either a user ID or an email address',
    path: ['userId'],
  });

const refresh = z.object({
  refreshToken: z.string().min(20, 'Provide the refresh token').max(500),
});

const logout = z.object({
  refreshToken: z.string().max(500).optional(),
});

const newPassword = z
  .string()
  .min(MIN_LENGTH, `Use at least ${MIN_LENGTH} characters`)
  .max(200);

const changePassword = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(200),
    newPassword,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  });

const forgotPassword = z.object({ email });

const resetPassword = z.object({
  token: z.string().min(20, 'The reset link is incomplete').max(500),
  newPassword,
});

const idParam = z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Not a valid identifier') });

module.exports = {
  login,
  refresh,
  logout,
  changePassword,
  forgotPassword,
  resetPassword,
  idParam,
};
