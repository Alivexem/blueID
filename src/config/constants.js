'use strict';

/**
 * Domain vocabulary for the Cross River State Blue ID & Fisheries IMS.
 * Every enum the models validate against lives here so the API, the portal and
 * the field app can be kept in step from one place.
 */

/** Portal / field-app roles (concept note §3B). */
const ROLES = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  STATE_ADMIN: 'STATE_ADMIN',
  MINISTRY_OFFICER: 'MINISTRY_OFFICER',
  LGA_ADMIN: 'LGA_ADMIN',
  ENUMERATOR: 'ENUMERATOR',
  COOPERATIVE_OFFICER: 'COOPERATIVE_OFFICER',
});

const ROLE_VALUES = Object.values(ROLES);

/**
 * Higher rank implies every capability of the ranks below it, and state-wide
 * roles (rank >= 80) are exempt from LGA scoping.
 */
const ROLE_RANK = Object.freeze({
  [ROLES.SUPER_ADMIN]: 100,
  [ROLES.STATE_ADMIN]: 90,
  [ROLES.MINISTRY_OFFICER]: 80,
  [ROLES.LGA_ADMIN]: 60,
  [ROLES.COOPERATIVE_OFFICER]: 40,
  [ROLES.ENUMERATOR]: 20,
});

const STATE_WIDE_RANK = 80;

const USER_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DISABLED: 'DISABLED',
});

/**
 * Explicit capabilities.
 *
 * Role rank alone is too blunt for this system: "can edit a fisherman" and
 * "can approve a benefit worth ₦1.8m" are different powers that happen to sit
 * at similar levels of seniority. Routes are guarded by the capability they
 * actually need, so a role can be re-scoped without hunting through the
 * route table, and separation of duties (register / verify / approve) is
 * expressible rather than implied.
 */
const PERMISSIONS = Object.freeze({
  FISHERMAN_READ: 'fisherman:read',
  FISHERMAN_CREATE: 'fisherman:create',
  FISHERMAN_EDIT: 'fisherman:edit',
  FISHERMAN_DELETE: 'fisherman:delete',
  FISHERMAN_READ_SENSITIVE: 'fisherman:read_sensitive', // NIN and similar
  REGISTRATION_VERIFY: 'registration:verify',
  REGISTRATION_STATUS: 'registration:status',
  DUPLICATE_RESOLVE: 'duplicate:resolve',
  DUPLICATE_MERGE: 'duplicate:merge',
  ASSET_MANAGE: 'asset:manage',
  ASSET_TRANSFER: 'asset:transfer',
  PROGRAMME_MANAGE: 'programme:manage',
  BENEFIT_ALLOCATE: 'benefit:allocate',
  BENEFIT_APPROVE: 'benefit:approve',
  BENEFIT_DELIVER: 'benefit:deliver',
  COOPERATIVE_MANAGE: 'cooperative:manage',
  COMMUNITY_MANAGE: 'community:manage',
  DEVICE_MANAGE: 'device:manage',
  SYNC_SUBMIT: 'sync:submit',
  REPORT_EXPORT: 'report:export',
  DASHBOARD_VIEW: 'dashboard:view',
  AUDIT_READ: 'audit:read',
  USER_MANAGE: 'user:manage',
  USER_ASSIGN_ROLE: 'user:assign_role',
});

const P = PERMISSIONS;

/**
 * Capability grants per role. An enumerator can create and edit but can never
 * verify their own work; allocating a benefit and approving it are separate
 * grants held by different roles.
 */
const ROLE_PERMISSIONS = Object.freeze({
  [ROLES.ENUMERATOR]: Object.freeze([
    P.FISHERMAN_READ,
    P.FISHERMAN_CREATE,
    P.FISHERMAN_EDIT,
    P.ASSET_MANAGE,
    P.SYNC_SUBMIT,
    P.BENEFIT_DELIVER,
  ]),
  [ROLES.COOPERATIVE_OFFICER]: Object.freeze([
    P.FISHERMAN_READ,
    P.COOPERATIVE_MANAGE,
    P.DASHBOARD_VIEW,
  ]),
  [ROLES.LGA_ADMIN]: Object.freeze([
    P.FISHERMAN_READ,
    P.FISHERMAN_CREATE,
    P.FISHERMAN_EDIT,
    P.FISHERMAN_DELETE,
    P.FISHERMAN_READ_SENSITIVE,
    P.REGISTRATION_VERIFY,
    P.REGISTRATION_STATUS,
    P.DUPLICATE_RESOLVE,
    P.ASSET_MANAGE,
    P.ASSET_TRANSFER,
    P.BENEFIT_ALLOCATE,
    P.BENEFIT_DELIVER,
    P.COOPERATIVE_MANAGE,
    P.COMMUNITY_MANAGE,
    P.DEVICE_MANAGE,
    P.SYNC_SUBMIT,
    P.REPORT_EXPORT,
    P.DASHBOARD_VIEW,
    P.AUDIT_READ,
    P.USER_MANAGE,
    // Capped by rank to roles below their own — an LGA administrator can
    // appoint enumerators and cooperative officers, nobody higher.
    P.USER_ASSIGN_ROLE,
  ]),
  [ROLES.MINISTRY_OFFICER]: Object.freeze([
    P.FISHERMAN_READ,
    P.FISHERMAN_READ_SENSITIVE,
    P.REGISTRATION_VERIFY,
    P.REGISTRATION_STATUS,
    P.DUPLICATE_RESOLVE,
    P.PROGRAMME_MANAGE,
    P.BENEFIT_ALLOCATE,
    P.BENEFIT_APPROVE,
    P.REPORT_EXPORT,
    P.DASHBOARD_VIEW,
    P.AUDIT_READ,
  ]),
  [ROLES.STATE_ADMIN]: Object.freeze([
    ...Object.values(P).filter((p) => p !== P.USER_ASSIGN_ROLE),
    P.USER_ASSIGN_ROLE,
  ]),
  /**
   * Oversight, not operations.
   *
   * The Super Administrator exists to put the other accounts in place and to
   * watch what they do with them. It deliberately holds none of the
   * operational grants: it cannot register or edit a fisherman, verify a
   * registration, issue a Blue ID, move an asset, run a programme, allocate a
   * benefit or export the register. Those belong to the State Administrator
   * and below.
   *
   * The reason is separation of duties. This is the account that creates every
   * other account, including the one that can do all of those things; if it
   * could also perform them itself, the audit trail it is meant to police
   * would be a record of its own work, and the bootstrap credential would be a
   * skeleton key to the citizen register.
   *
   * Note that rank still outranks everybody (ROLE_RANK), which is what lets it
   * create a State Administrator. Rank governs WHO you may create. It must not
   * be allowed to govern WHAT you may do — every route that gates on rank
   * alone also gates on a permission, or this list means nothing.
   */
  [ROLES.SUPER_ADMIN]: Object.freeze([
    P.USER_MANAGE,
    P.USER_ASSIGN_ROLE,
    P.AUDIT_READ,
    P.DASHBOARD_VIEW,
  ]),
});

/** Blue ID lifecycle (concept note §5). */
const FISHERMAN_STATUS = Object.freeze({
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  DECEASED: 'DECEASED',
  INACTIVE: 'INACTIVE',
  DUPLICATE_UNDER_REVIEW: 'DUPLICATE_UNDER_REVIEW',
});

/**
 * Permitted fisherman status transitions.
 *
 * There were no transition rules at all: `changeStatus` accepted any value in
 * the enum, so a record could go straight from DECEASED back to ACTIVE, or
 * from DUPLICATE_UNDER_REVIEW to ACTIVE without the duplicate ever being
 * resolved. A lifecycle that only exists in the UI is not a lifecycle.
 *
 * Read as: from -> the states it may move to.
 */
const FISHERMAN_TRANSITIONS = Object.freeze({
  PENDING_VERIFICATION: ['ACTIVE', 'DUPLICATE_UNDER_REVIEW', 'INACTIVE', 'DECEASED'],
  // Verification issues the Blue ID, so ACTIVE is reached through verify().
  ACTIVE: ['SUSPENDED', 'INACTIVE', 'DECEASED', 'DUPLICATE_UNDER_REVIEW'],
  SUSPENDED: ['ACTIVE', 'INACTIVE', 'DECEASED'],
  INACTIVE: ['ACTIVE', 'DECEASED'],
  // Resolving the duplicate review is what releases a record, not a status edit.
  DUPLICATE_UNDER_REVIEW: ['INACTIVE', 'DECEASED'],
  /**
   * Terminal. Reversing a death record is a correction, not a status change:
   * it needs evidence and a state administrator, so it goes through the
   * dedicated path rather than the ordinary status endpoint.
   */
  DECEASED: [],
});

/**
 * Permitted allocation status transitions.
 *
 * Without these, `changeAllocationStatus` could set DELIVERED directly —
 * skipping the acknowledgement capture, the deliveredAt/deliveredBy record
 * and the counter increment that `markDelivered` performs. The delivery
 * evidence would simply be absent while the record claimed delivery.
 */
const ALLOCATION_TRANSITIONS = Object.freeze({
  PENDING: ['APPROVED', 'REJECTED', 'REVOKED'],
  // DELIVERED is reached only through markDelivered(), which captures proof.
  APPROVED: ['REVOKED', 'REJECTED'],
  DELIVERED: ['REVOKED'],
  REJECTED: [],
  REVOKED: [],
});

/** A single person may hold several of these (concept note §4b). */
const FISHERMAN_TYPES = Object.freeze({
  ARTISANAL: 'ARTISANAL',
  COMMERCIAL: 'COMMERCIAL',
  FISH_FARMER: 'FISH_FARMER',
  BOAT_OWNER: 'BOAT_OWNER',
  CREW_MEMBER: 'CREW_MEMBER',
  FISH_PROCESSOR: 'FISH_PROCESSOR',
  FISH_TRADER: 'FISH_TRADER',
});

const FISHING_TYPES = Object.freeze({
  MARINE: 'MARINE',
  RIVER: 'RIVER',
  CREEK: 'CREEK',
  ESTUARY: 'ESTUARY',
  INLAND: 'INLAND',
  AQUACULTURE: 'AQUACULTURE',
});

const GENDERS = Object.freeze({ MALE: 'MALE', FEMALE: 'FEMALE', OTHER: 'OTHER' });

const BOAT_TYPES = Object.freeze({
  DUGOUT_CANOE: 'DUGOUT_CANOE',
  PLANK_CANOE: 'PLANK_CANOE',
  FIBREGLASS_BOAT: 'FIBREGLASS_BOAT',
  WOODEN_BOAT: 'WOODEN_BOAT',
  ALUMINIUM_BOAT: 'ALUMINIUM_BOAT',
  TRAWLER: 'TRAWLER',
  OTHER: 'OTHER',
});

const PROPULSION_TYPES = Object.freeze({
  PADDLE: 'PADDLE',
  SAIL: 'SAIL',
  OUTBOARD_ENGINE: 'OUTBOARD_ENGINE',
  INBOARD_ENGINE: 'INBOARD_ENGINE',
});

const EQUIPMENT_TYPES = Object.freeze({
  FISHING_NET: 'FISHING_NET',
  FISHING_GEAR: 'FISHING_GEAR',
  COLD_BOX: 'COLD_BOX',
  ICE_BOX: 'ICE_BOX',
  SAFETY_EQUIPMENT: 'SAFETY_EQUIPMENT',
  GPS_EQUIPMENT: 'GPS_EQUIPMENT',
  LIFE_JACKET: 'LIFE_JACKET',
  SMOKING_KILN: 'SMOKING_KILN',
  OTHER: 'OTHER',
});

const ASSET_CONDITION = Object.freeze({
  NEW: 'NEW',
  GOOD: 'GOOD',
  FAIR: 'FAIR',
  POOR: 'POOR',
  NOT_WORKING: 'NOT_WORKING',
});

const ACQUISITION_SOURCE = Object.freeze({
  PERSONAL: 'PERSONAL',
  GOVERNMENT_PROGRAMME: 'GOVERNMENT_PROGRAMME',
  COOPERATIVE: 'COOPERATIVE',
  DONOR: 'DONOR',
  INHERITED: 'INHERITED',
  LEASED: 'LEASED',
});

/** Government interventions (concept note §6). */
const PROGRAMME_TYPES = Object.freeze({
  OUTBOARD_ENGINE_DISTRIBUTION: 'OUTBOARD_ENGINE_DISTRIBUTION',
  FISHING_NET_DISTRIBUTION: 'FISHING_NET_DISTRIBUTION',
  BOAT_DISTRIBUTION: 'BOAT_DISTRIBUTION',
  LIFE_JACKET_PROGRAMME: 'LIFE_JACKET_PROGRAMME',
  FUEL_SUBSIDY: 'FUEL_SUBSIDY',
  GRANT: 'GRANT',
  LOAN: 'LOAN',
  FISH_SMOKING_EQUIPMENT: 'FISH_SMOKING_EQUIPMENT',
  COLD_STORAGE_SUPPORT: 'COLD_STORAGE_SUPPORT',
  AQUACULTURE_INPUTS: 'AQUACULTURE_INPUTS',
  INSURANCE: 'INSURANCE',
  TRAINING: 'TRAINING',
  OTHER: 'OTHER',
});

const PROGRAMME_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  ARCHIVED: 'ARCHIVED',
});

const ALLOCATION_STATUS = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  DELIVERED: 'DELIVERED',
  REJECTED: 'REJECTED',
  REVOKED: 'REVOKED',
});

const COMMUNITY_TYPES = Object.freeze({
  COASTAL: 'COASTAL',
  RIVERINE: 'RIVERINE',
  ESTUARINE: 'ESTUARINE',
  INLAND: 'INLAND',
});

/** Where a record originated — drives the sync + audit story. */
const REGISTRATION_CHANNEL = Object.freeze({
  MOBILE_OFFLINE: 'MOBILE_OFFLINE',
  MOBILE_ONLINE: 'MOBILE_ONLINE',
  WEB_PORTAL: 'WEB_PORTAL',
  BULK_IMPORT: 'BULK_IMPORT',
});

const DEVICE_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  REVOKED: 'REVOKED',
});

const SYNC_BATCH_STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
});

const SYNC_RECORD_RESULT = Object.freeze({
  CREATED: 'CREATED',
  UPDATED: 'UPDATED',
  DUPLICATE_IGNORED: 'DUPLICATE_IGNORED',
  FLAGGED_DUPLICATE: 'FLAGGED_DUPLICATE',
  CONFLICT: 'CONFLICT',
  REJECTED: 'REJECTED',
});

const SYNC_ENTITIES = Object.freeze({
  FISHERMAN: 'FISHERMAN',
  BOAT: 'BOAT',
  ENGINE: 'ENGINE',
  EQUIPMENT: 'EQUIPMENT',
  ALLOCATION: 'ALLOCATION',
});

const AUDIT_ACTIONS = Object.freeze({
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  RESTORE: 'RESTORE',
  VIEW_SENSITIVE: 'VIEW_SENSITIVE',
  VERIFY: 'VERIFY',
  STATUS_CHANGE: 'STATUS_CHANGE',
  BLUE_ID_ISSUED: 'BLUE_ID_ISSUED',
  DUPLICATE_FLAGGED: 'DUPLICATE_FLAGGED',
  DUPLICATE_RESOLVED: 'DUPLICATE_RESOLVED',
  MERGE: 'MERGE',
  SYNC_PUSH: 'SYNC_PUSH',
  SYNC_PULL: 'SYNC_PULL',
  EXPORT: 'EXPORT',
  LOGIN: 'LOGIN',
  ROLE_CHANGE: 'ROLE_CHANGE',
  DEVICE_REGISTERED: 'DEVICE_REGISTERED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  ALLOCATION_ISSUED: 'ALLOCATION_ISSUED',
});

/**
 * The 18 LGAs of Cross River State. `code` is the segment used inside a Blue ID
 * (CRS-BLU-<code>-0001) and is therefore permanent — never renumber these.
 */
const LGAS = Object.freeze([
  { code: 'ABI', name: 'Abi', zone: 'Central', waterfront: true },
  { code: 'AKA', name: 'Akamkpa', zone: 'South', waterfront: true },
  { code: 'AKP', name: 'Akpabuyo', zone: 'South', waterfront: true },
  { code: 'BAK', name: 'Bakassi', zone: 'South', waterfront: true },
  { code: 'BEK', name: 'Bekwarra', zone: 'North', waterfront: false },
  { code: 'BIA', name: 'Biase', zone: 'Central', waterfront: true },
  { code: 'BOK', name: 'Boki', zone: 'Central', waterfront: false },
  { code: 'CAM', name: 'Calabar Municipality', zone: 'South', waterfront: true },
  { code: 'CAS', name: 'Calabar South', zone: 'South', waterfront: true },
  { code: 'ETU', name: 'Etung', zone: 'Central', waterfront: false },
  { code: 'IKM', name: 'Ikom', zone: 'Central', waterfront: true },
  { code: 'OBA', name: 'Obanliku', zone: 'North', waterfront: false },
  { code: 'OBU', name: 'Obubra', zone: 'Central', waterfront: true },
  { code: 'OBD', name: 'Obudu', zone: 'North', waterfront: false },
  { code: 'ODU', name: 'Odukpani', zone: 'South', waterfront: true },
  { code: 'OGJ', name: 'Ogoja', zone: 'North', waterfront: false },
  { code: 'YAK', name: 'Yakurr', zone: 'Central', waterfront: true },
  { code: 'YAL', name: 'Yala', zone: 'North', waterfront: false },
]);

const LGA_CODES = Object.freeze(LGAS.map((l) => l.code));
const LGA_BY_CODE = Object.freeze(Object.fromEntries(LGAS.map((l) => [l.code, l])));

/** Infrastructure gaps the dashboard reports on (concept note §7 and §8). */
const FACILITY_KEYS = Object.freeze([
  'landingSite',
  'coldStorage',
  'iceplant',
  'processingFacility',
  'boatRepair',
  'jetty',
  'market',
]);

const SOFT_DELETE_FILTER = Object.freeze({ isDeleted: { $ne: true } });

module.exports = {
  ROLES,
  ROLE_VALUES,
  ROLE_RANK,
  STATE_WIDE_RANK,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  USER_STATUS,
  FISHERMAN_STATUS,
  FISHERMAN_TRANSITIONS,
  ALLOCATION_TRANSITIONS,
  FISHERMAN_TYPES,
  FISHING_TYPES,
  GENDERS,
  BOAT_TYPES,
  PROPULSION_TYPES,
  EQUIPMENT_TYPES,
  ASSET_CONDITION,
  ACQUISITION_SOURCE,
  PROGRAMME_TYPES,
  PROGRAMME_STATUS,
  ALLOCATION_STATUS,
  COMMUNITY_TYPES,
  REGISTRATION_CHANNEL,
  DEVICE_STATUS,
  SYNC_BATCH_STATUS,
  SYNC_RECORD_RESULT,
  SYNC_ENTITIES,
  AUDIT_ACTIONS,
  LGAS,
  LGA_CODES,
  LGA_BY_CODE,
  FACILITY_KEYS,
  SOFT_DELETE_FILTER,
};
