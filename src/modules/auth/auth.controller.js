'use strict';

const service = require('./auth.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created } = require('../../utils/response');

const login = asyncHandler(async function login(req, res) {
  const result = await service.login(req.body, { req });
  return ok(res, result, {
    message: result.mustChangePassword
      ? 'Signed in. You must choose a new password before continuing.'
      : 'Signed in',
  });
});

const refresh = asyncHandler(async function refresh(req, res) {
  const result = await service.refresh(req.body, { req });
  return ok(res, result, { message: 'Session renewed' });
});

const logout = asyncHandler(async function logout(req, res) {
  const result = await service.logout(req.body, req.user, { req });
  return ok(res, result, { message: 'Signed out' });
});

const logoutAll = asyncHandler(async function logoutAll(req, res) {
  const result = await service.logoutAll(req.user, { req });
  return ok(res, result, { message: 'Signed out on every device' });
});

const sessions = asyncHandler(async function sessions(req, res) {
  return ok(res, await service.listSessions(req.user));
});

const changePassword = asyncHandler(async function changePassword(req, res) {
  const result = await service.changePassword(req.user, req.body, { req });
  return ok(res, result, {
    message: 'Password changed. Other devices have been signed out.',
  });
});

const forgotPassword = asyncHandler(async function forgotPassword(req, res) {
  const result = await service.forgotPassword(req.body, { req });
  return ok(res, { ok: true }, { message: result.message });
});

const resetPassword = asyncHandler(async function resetPassword(req, res) {
  const result = await service.resetPassword(req.body, { req });
  return ok(res, result, { message: 'Password set. Please sign in.' });
});

const adminResetPassword = asyncHandler(async function adminResetPassword(req, res) {
  const result = await service.adminResetPassword(req.params.id, req.user, { req });
  return created(res, result, {
    message: 'Temporary password issued. Share it securely — it is shown only once.',
  });
});

module.exports = {
  login,
  refresh,
  logout,
  logoutAll,
  sessions,
  changePassword,
  forgotPassword,
  resetPassword,
  adminResetPassword,
};
