'use strict';

const users = require('./user.repository');
const firebase = require('../../config/firebase');
const passwordUtil = require('../../utils/password');
const authService = require('../auth/auth.service');
const auditService = require('../../services/audit.service');
const emailService = require('../../services/email.service');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const { resolvePagination } = require('../../utils/pagination');
const {
  rankOf,
  isStateWide,
  scopedLgas,
  hasPermission,
  permissionsFor,
} = require('../../middleware/authorize');
const { USER_STATUS, AUDIT_ACTIONS, PERMISSIONS, ROLES } = require('../../config/constants');

/**
 * Operator accounts.
 *
 * Sign-in belongs to the client application; this module owns what the API
 * cares about — who someone is, what role they hold, and which LGAs they may
 * touch. An account is created here first (by invitation) and bound to an
 * identity-provider subject the first time that person authenticates.
 *
 * Privilege escalation is blocked in both directions: nobody may create or
 * promote a user to a role at or above their own, and nobody may assign an LGA
 * outside their own scope.
 */

/**
 * Setting somebody's role is a separate grant from managing their account.
 *
 * It was declared in the permission table from the start and never checked,
 * which made it decorative: role assignment was governed only by the rank
 * comparison below. Both now apply — the permission decides whether you may
 * assign a role at all, rank decides how high.
 */
function assertCanAssignRole(actor, targetRole) {
  if (!hasPermission(actor, PERMISSIONS.USER_ASSIGN_ROLE)) {
    throw ApiError.forbidden('You cannot assign roles', {
      code: 'MISSING_PERMISSION',
      details: { required: PERMISSIONS.USER_ASSIGN_ROLE, yourRole: actor.role, requestedRole: targetRole },
    });
  }
}

function assertCanManage(actor, targetRole, targetLgas = []) {
  if (rankOf(targetRole) >= rankOf(actor.role)) {
    throw ApiError.forbidden('You cannot assign a role at or above your own', {
      details: { yourRole: actor.role, requestedRole: targetRole },
    });
  }
  if (!isStateWide(actor)) {
    const allowed = scopedLgas(actor);
    const outside = targetLgas.filter((lga) => !allowed.includes(lga));
    if (outside.length) {
      throw ApiError.forbidden('You cannot assign Local Government Areas outside your own scope', {
        details: { outside, yourLgas: allowed },
      });
    }
  }
}

/**
 * Invites an officer. The account starts ACTIVE but unbound: it has no
 * `authUid` until the person signs in through the client's identity provider
 * with the matching email, at which point the two are linked.
 */
async function invite(payload, actor, options = {}) {
  const { req } = options;
  assertCanAssignRole(actor, payload.role);
  assertCanManage(actor, payload.role, payload.scope?.lgas || []);

  const existing = await users.findByEmail(payload.email);
  if (existing) {
    throw ApiError.conflict('An account with that email address already exists', {
      code: 'EMAIL_TAKEN',
      details: { id: existing._id, status: existing.status },
    });
  }

  if (payload.role === ROLES.COOPERATIVE_OFFICER && !payload.cooperative) {
    throw ApiError.badRequest('A cooperative officer must be linked to a cooperative');
  }

  /**
   * The account is created WITH a credential.
   *
   * Either way it is flagged `mustChangePassword` — a generated one because
   * nobody has chosen it yet, an administrator-supplied one because the
   * administrator knows it. Until the holder replaces it, `authenticate`
   * refuses every route but the handful in middleware/requirePasswordChange.js,
   * so an invitation password cannot become a working shared credential.
   */
  const temporaryPassword = payload.password || passwordUtil.generateTemporary();
  const isGenerated = !payload.password;

  if (payload.password) {
    authService.assertPasswordAcceptable(payload.password, payload);
  }

  const user = await users.create({
    ...payload,
    password: undefined,
    email: payload.email.toLowerCase(),
    passwordHash: await passwordUtil.hash(temporaryPassword),
    passwordChangedAt: new Date(),
    mustChangePassword: true,
    status: USER_STATUS.ACTIVE,
    invitedBy: actor._id,
    invitedAt: new Date(),
  });

  await auditService.record({
    action: AUDIT_ACTIONS.CREATE,
    entity: { type: 'User', id: user._id, label: user.fullName },
    metadata: { role: user.role, lgas: user.scope?.lgas },
    req,
  });

  // Delivery failure must not fail the invitation — the account exists either way.
  emailService
    .sendOfficerInvite({
      to: user.email,
      name: user.fullName,
      role: user.role,
      invitedBy: actor.fullName,
    })
    .catch(() => {});

  /**
   * The temporary password is returned ONCE, and only when the system
   * generated it. If the administrator chose one they already know it, and
   * echoing it back would put it in another log and another screen.
   */
  return {
    user,
    ...(isGenerated ? { temporaryPassword, mustChangePassword: true } : {}),
  };
}

async function list(query, actor) {
  const pagination = resolvePagination(query);

  return users.list({
    page: pagination.page,
    limit: pagination.limit,
    role: query.role,
    status: query.status,
    lga: query.lga,
    search: query.search,
    // An LGA administrator sees only staff working in their own areas. The
    // filter goes into the SQL rather than being applied after loading, so a
    // page of results cannot be mostly rows the caller may not see.
    scopeLgas: isStateWide(actor) ? undefined : scopedLgas(actor),
  });
}

async function getById(id, actor, { includeIdentity = false } = {}) {
  const user = await users.findById(id);
  if (!user) throw ApiError.notFound('User not found');

  if (!isStateWide(actor) && String(user.id) !== String(actor.id)) {
    const overlap = (user.scope?.lgas || []).some((lga) => scopedLgas(actor).includes(lga));
    if (!overlap) throw ApiError.forbidden('That user is outside your scope');
  }

  /**
   * The identity-provider view, for an administrator investigating why
   * someone cannot sign in. Read live rather than mirrored here, so it
   * cannot go stale. Only relevant in the external-identity modes.
   */
  if (includeIdentity && user.authUid) {
    const identity = await firebase.getUser(user.authUid);
    return { ...user, identity };
  }

  return user;
}

async function update(id, payload, actor, options = {}) {
  const { req } = options;
  const user = await getById(id, actor);
  const before = { ...user };

  // Role and scope changes are privileged; profile fields are not.
  if (payload.role && payload.role !== user.role) {
    assertCanAssignRole(actor, payload.role);
    assertCanManage(actor, payload.role, payload.scope?.lgas || user.scope?.lgas || []);
  }
  if (payload.scope) {
    assertCanManage(actor, payload.role || user.role, payload.scope.lgas || []);
  }
  if (String(user.id) === String(actor.id) && payload.role) {
    throw ApiError.forbidden('You cannot change your own role');
  }

  // `authUid` is set by the authentication flow, never by an administrator.
  delete payload.authUid;

  const updated = await users.update(user.id, payload);

  const roleChanged = before.role !== updated.role;
  await auditService.record({
    action: roleChanged ? AUDIT_ACTIONS.ROLE_CHANGE : AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: updated.id, label: updated.fullName },
    changes: auditService.diff(before, updated),
    req,
  });

  return updated;
}

/** Approves an auto-provisioned account that is waiting for a role. */
async function activate(id, { role, scope }, actor, options = {}) {
  const { req } = options;
  const user = await users.findById(id);
  if (!user) throw ApiError.notFound('User not found');

  if (role && role !== user.role) assertCanAssignRole(actor, role);
  assertCanManage(actor, role || user.role, scope?.lgas || user.scope?.lgas || []);

  const before = { ...user };
  const updated = await users.update(user.id, {
    ...(role ? { role } : {}),
    ...(scope ? { scope } : {}),
    status: USER_STATUS.ACTIVE,
    activatedAt: new Date(),
  });

  await auditService.record({
    action: AUDIT_ACTIONS.ROLE_CHANGE,
    entity: { type: 'User', id: updated.id, label: updated.fullName },
    changes: auditService.diff(before, updated),
    req,
  });

  if (updated.email) {
    emailService
      .sendAccountActivated({ to: updated.email, name: updated.fullName, role: updated.role })
      .catch(() => {});
  }

  return updated;
}

async function changeStatus(id, { status, reason }, actor, options = {}) {
  const { req } = options;
  if (String(id) === String(actor._id)) {
    throw ApiError.forbidden('You cannot change your own account status');
  }

  const user = await getById(id, actor);
  if (rankOf(user.role) >= rankOf(actor.role)) {
    throw ApiError.forbidden('You cannot modify an account at or above your own role');
  }

  const before = { ...user };
  const updated = await users.update(user.id, { status });

  /**
   * Keep the identity provider in step with the local decision.
   *
   * The local status is re-read on every request, so suspension already takes
   * effect here immediately. Revoking at Firebase closes the other half: it
   * invalidates the refresh token, so the account cannot mint a fresh ID token
   * once the current one expires, and `verifyIdToken(..., checkRevoked)`
   * rejects the outstanding one on its next use.
   *
   * Deliberately not awaited into the failure path — if Firebase is
   * unreachable the officer is still blocked by the status check, and the
   * failure is logged for follow-up rather than leaving the account active
   * here because a remote call timed out.
   */
  const deactivating = [USER_STATUS.SUSPENDED, USER_STATUS.DISABLED].includes(status);
  let identityResult = null;

  /**
   * End every local session immediately. The status check on each request
   * already blocks the account, but revoking the refresh tokens stops it
   * renewing and makes the sign-out visible in the session list.
   */
  if (deactivating) {
    const sessions = require('../auth/session.repository');
    const revoked = await sessions.revokeAllForUser(user.id, `account ${status.toLowerCase()}`);
    logger.info(
      { userId: String(user.id), sessionsRevoked: revoked.modifiedCount },
      'Local sessions revoked on deactivation'
    );
  }

  if (user.authUid) {
    identityResult = deactivating
      ? await firebase.revokeAccess(user.authUid, { disable: status === USER_STATUS.DISABLED })
      : before.status !== USER_STATUS.ACTIVE && status === USER_STATUS.ACTIVE
        ? await firebase.restoreAccess(user.authUid)
        : null;
  }

  await auditService.record({
    action: AUDIT_ACTIONS.STATUS_CHANGE,
    entity: { type: 'User', id: updated.id, label: updated.fullName },
    changes: auditService.diff(before, updated),
    metadata: { reason, identityProvider: identityResult },
    req,
  });

  return updated;
}

/** The caller's own profile — what the portal loads on sign-in. */
async function me(actor) {
  const user = await users.findById(actor.id);
  if (!user) throw ApiError.notFound('Account not found');

  const { LGA_BY_CODE } = require('../../config/constants');

  return {
    ...user,
    /**
     * Resolved so the portal can render menus without a second call.
     *
     * Each flag is read from the SAME permission set the routes are guarded
     * on. They were previously derived from rank, which drifted: a Ministry
     * Officer was told `canRegisterDevices` was true although `device:manage`
     * is not granted to that role, so the portal drew a control that answered
     * 403. A convenience flag that disagrees with the guard is worse than no
     * flag at all.
     *
     * `granted` carries the full list for anything these five do not cover.
     */
    permissions: {
      isStateWide: isStateWide(actor),
      canVerify: hasPermission(actor, PERMISSIONS.REGISTRATION_VERIFY),
      canManageUsers: hasPermission(actor, PERMISSIONS.USER_MANAGE),
      canManageProgrammes: hasPermission(actor, PERMISSIONS.PROGRAMME_MANAGE),
      canExport: hasPermission(actor, PERMISSIONS.REPORT_EXPORT),
      canRegisterDevices: hasPermission(actor, PERMISSIONS.DEVICE_MANAGE),
      canReadAudit: hasPermission(actor, PERMISSIONS.AUDIT_READ),
      canReadRegister: hasPermission(actor, PERMISSIONS.FISHERMAN_READ),
      granted: permissionsFor(actor.role),
    },
    lgas: (user.scope?.lgas || []).map((code) => ({
      code,
      name: LGA_BY_CODE[code]?.name || code,
    })),
  };
}

/** Self-service profile update — contact details only. */
async function updateMe(actor, payload, options = {}) {
  const { req } = options;
  const user = await users.findById(actor.id);
  if (!user) throw ApiError.notFound('Account not found');
  const before = { ...user };

  // Contact details only. Role, scope and status are not self-service, and
  // listing the allowed fields is what stops a payload reaching them.
  const changes = {};
  for (const field of ['firstName', 'lastName', 'phone', 'designation']) {
    if (payload[field] !== undefined) changes[field] = payload[field];
  }

  const updated = await users.update(user.id, changes);

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: updated.id, label: updated.fullName },
    changes: auditService.diff(before, updated),
    req,
  });

  return updated;
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { invite, list, getById, update, activate, changeStatus, me, updateMe };
