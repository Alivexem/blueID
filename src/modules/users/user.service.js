'use strict';

const User = require('./user.model');
const passwordUtil = require('../../utils/password');
const authService = require('../auth/auth.service');
const auditService = require('../../services/audit.service');
const emailService = require('../../services/email.service');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const { paginate, resolvePagination } = require('../../utils/pagination');
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

  const existing = await User.findOne({ email: payload.email.toLowerCase() });
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

  const user = await User.create({
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
  const filter = { isDeleted: { $ne: true } };

  if (query.role) filter.role = query.role;
  if (query.status) filter.status = query.status;
  if (query.lga) filter['scope.lgas'] = query.lga;
  if (query.search) {
    const term = escapeRegex(query.search);
    filter.$or = [
      { firstName: new RegExp(term, 'i') },
      { lastName: new RegExp(term, 'i') },
      { email: new RegExp(term, 'i') },
    ];
  }

  // An LGA administrator sees only the staff working in their own LGAs.
  if (!isStateWide(actor)) {
    filter['scope.lgas'] = { $in: scopedLgas(actor) };
  }

  return paginate(User, filter, pagination, {
    sort: { createdAt: -1 },
    populate: [
      { path: 'invitedBy', select: 'firstName lastName' },
      { path: 'cooperative', select: 'name lga' },
    ],
  });
}

async function getById(id, actor) {
  const user = await User.findOne({ _id: id, isDeleted: { $ne: true } })
    .populate('invitedBy', 'firstName lastName email')
    .populate('cooperative', 'name lga')
    .populate('scope.communities', 'name lga');
  if (!user) throw ApiError.notFound('User not found');

  if (!isStateWide(actor) && String(user._id) !== String(actor._id)) {
    const overlap = (user.scope?.lgas || []).some((lga) => scopedLgas(actor).includes(lga));
    if (!overlap) throw ApiError.forbidden('That user is outside your scope');
  }


  return user;
}

async function update(id, payload, actor, options = {}) {
  const { req } = options;
  const user = await getById(id, actor);
  const before = user.toObject();

  // Role and scope changes are privileged; profile fields are not.
  if (payload.role && payload.role !== user.role) {
    assertCanAssignRole(actor, payload.role);
    assertCanManage(actor, payload.role, payload.scope?.lgas || user.scope?.lgas || []);
  }
  if (payload.scope) {
    assertCanManage(actor, payload.role || user.role, payload.scope.lgas || []);
  }
  if (String(user._id) === String(actor._id) && payload.role) {
    throw ApiError.forbidden('You cannot change your own role');
  }

  // `authUid` is set by the authentication flow, never by an administrator.
  delete payload.authUid;

  Object.assign(user, payload);
  await user.save();

  const roleChanged = before.role !== user.role;
  await auditService.record({
    action: roleChanged ? AUDIT_ACTIONS.ROLE_CHANGE : AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: user._id, label: user.fullName },
    changes: auditService.diff(before, user.toObject()),
    req,
  });

  return user;
}

/** Approves an auto-provisioned account that is waiting for a role. */
async function activate(id, { role, scope }, actor, options = {}) {
  const { req } = options;
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');

  if (role && role !== user.role) assertCanAssignRole(actor, role);
  assertCanManage(actor, role || user.role, scope?.lgas || user.scope?.lgas || []);

  const before = user.toObject();
  if (role) user.role = role;
  if (scope) user.scope = scope;
  user.status = USER_STATUS.ACTIVE;
  await user.save();

  await auditService.record({
    action: AUDIT_ACTIONS.ROLE_CHANGE,
    entity: { type: 'User', id: user._id, label: user.fullName },
    changes: auditService.diff(before, user.toObject()),
    req,
  });

  if (user.email) {
    emailService
      .sendAccountActivated({ to: user.email, name: user.fullName, role: user.role })
      .catch(() => {});
  }

  return user;
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

  const before = user.toObject();
  user.status = status;
  await user.save();

  const deactivating = [USER_STATUS.SUSPENDED, USER_STATUS.DISABLED].includes(status);

  /**
   * End every local session immediately. The status check on each request
   * already blocks the account, but revoking the refresh tokens stops it
   * renewing and makes the sign-out visible in the session list.
   */
  if (deactivating) {
    const Session = require('../auth/session.model');
    const revoked = await Session.revokeAllForUser(user._id, `account ${status.toLowerCase()}`);
    logger.info(
      { userId: String(user._id), sessionsRevoked: revoked.modifiedCount },
      'Local sessions revoked on deactivation'
    );
  }


  await auditService.record({
    action: AUDIT_ACTIONS.STATUS_CHANGE,
    entity: { type: 'User', id: user._id, label: user.fullName },
    changes: auditService.diff(before, user.toObject()),
    metadata: { reason },
    req,
  });

  return user;
}

/** The caller's own profile — what the portal loads on sign-in. */
async function me(actor) {
  const user = await User.findById(actor._id)
    .populate('cooperative', 'name lga')
    .populate('scope.communities', 'name lga')
    .lean();

  const { LGA_BY_CODE } = require('../../config/constants');

  return {
    ...user,
    id: user._id,
    fullName: [user.firstName, user.lastName].filter(Boolean).join(' '),
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
  const user = await User.findById(actor._id);
  const before = user.toObject();

  for (const field of ['firstName', 'lastName', 'phone', 'designation']) {
    if (payload[field] !== undefined) user[field] = payload[field];
  }
  await user.save();

  await auditService.record({
    action: AUDIT_ACTIONS.UPDATE,
    entity: { type: 'User', id: user._id, label: user.fullName },
    changes: auditService.diff(before, user.toObject()),
    req,
  });

  return user;
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { invite, list, getById, update, activate, changeStatus, me, updateMe };
