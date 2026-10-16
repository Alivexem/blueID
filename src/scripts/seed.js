'use strict';

/**
 * Development seed.
 *
 *   npm run seed            # add missing reference data
 *   npm run seed -- --reset # wipe operational collections first (NOT production)
 *
 * IMPORTANT: the communities below are an ILLUSTRATIVE STARTER SET so the API
 * is usable the moment it is cloned. They are not an authoritative list of
 * Cross River State's fishing settlements — replace them with the Department
 * of Blue Economy's official register before the system goes live. The LGA
 * codes in config/constants.js, by contrast, are permanent: they are embedded
 * in every Blue ID ever issued and must not be edited.
 */

const database = require('../config/database');
const logger = require('../config/logger');
const config = require('../config');

const Community = require('../modules/communities/community.model');
const Cooperative = require('../modules/cooperatives/cooperative.model');
const Programme = require('../modules/programmes/programme.model');
const User = require('../modules/users/user.model');
const Fisherman = require('../modules/fishermen/fisherman.model');
const Boat = require('../modules/assets/boat.model');
const Engine = require('../modules/assets/engine.model');
const Allocation = require('../modules/programmes/allocation.model');
const SyncBatch = require('../modules/sync/syncBatch.model');
const Device = require('../modules/sync/device.model');
const Counter = require('../modules/fishermen/counter.model');

const {
  ROLES,
  USER_STATUS,
  COMMUNITY_TYPES,
  PROGRAMME_TYPES,
  PROGRAMME_STATUS,
  FISHERMAN_TYPES,
  FISHING_TYPES,
} = require('../config/constants');

/** Starter communities, concentrated in the waterfront LGAs. */
const COMMUNITIES = [
  { name: 'Anantigha', lga: 'CAS', type: COMMUNITY_TYPES.ESTUARINE, facilities: { landingSite: true, market: true } },
  { name: 'Nsidung', lga: 'CAS', type: COMMUNITY_TYPES.ESTUARINE, facilities: { landingSite: true } },
  { name: 'Esuk Atu', lga: 'CAM', type: COMMUNITY_TYPES.RIVERINE, facilities: { landingSite: true } },
  { name: 'Marina Beach', lga: 'CAM', type: COMMUNITY_TYPES.ESTUARINE, facilities: { landingSite: true, jetty: true } },
  { name: 'Abana', lga: 'BAK', type: COMMUNITY_TYPES.COASTAL, facilities: { landingSite: true } },
  { name: 'Atabong', lga: 'BAK', type: COMMUNITY_TYPES.COASTAL, facilities: {} },
  { name: 'Ikang', lga: 'BAK', type: COMMUNITY_TYPES.COASTAL, facilities: { landingSite: true, market: true } },
  { name: 'Esuk Ewang', lga: 'AKP', type: COMMUNITY_TYPES.COASTAL, facilities: { landingSite: true } },
  { name: 'Ikot Nakanda', lga: 'AKP', type: COMMUNITY_TYPES.ESTUARINE, facilities: {} },
  { name: 'Ikot Offiong', lga: 'ODU', type: COMMUNITY_TYPES.RIVERINE, facilities: { landingSite: true } },
  { name: 'Eniong Abatim', lga: 'ODU', type: COMMUNITY_TYPES.RIVERINE, facilities: {} },
  { name: 'Adim', lga: 'BIA', type: COMMUNITY_TYPES.RIVERINE, facilities: { landingSite: true } },
  { name: 'Abini', lga: 'BIA', type: COMMUNITY_TYPES.RIVERINE, facilities: {} },
  { name: 'Ugep Waterside', lga: 'YAK', type: COMMUNITY_TYPES.RIVERINE, facilities: { landingSite: true } },
  { name: 'Obubra Waterside', lga: 'OBU', type: COMMUNITY_TYPES.RIVERINE, facilities: {} },
  { name: 'Oku Iboku Crossing', lga: 'IKM', type: COMMUNITY_TYPES.RIVERINE, facilities: {} },
  { name: 'Awi Waterside', lga: 'AKA', type: COMMUNITY_TYPES.INLAND, facilities: {} },
  { name: 'Mbarakom', lga: 'AKA', type: COMMUNITY_TYPES.RIVERINE, facilities: {} },
];

const PROGRAMMES = [
  {
    name: 'Outboard Engine Distribution 2026',
    code: 'OED-2026',
    type: PROGRAMME_TYPES.OUTBOARD_ENGINE_DISTRIBUTION,
    year: 2026,
    status: PROGRAMME_STATUS.OPEN,
    itemDescription: '15HP outboard engine',
    unitValue: 1_850_000,
    targetBeneficiaries: 250,
    eligibility: {
      fishermanTypes: [FISHERMAN_TYPES.ARTISANAL, FISHERMAN_TYPES.BOAT_OWNER],
      requiresBoatOwnership: true,
      requiresVerifiedBlueId: true,
      minYearsFishing: 2,
      excludeIfReceivedWithinMonths: 36,
    },
  },
  {
    name: 'Fishing Net Distribution 2026',
    code: 'FND-2026',
    type: PROGRAMME_TYPES.FISHING_NET_DISTRIBUTION,
    year: 2026,
    status: PROGRAMME_STATUS.OPEN,
    itemDescription: 'Gill net, 3-inch mesh',
    unitValue: 95_000,
    targetBeneficiaries: 1200,
    eligibility: { requiresVerifiedBlueId: true, excludeIfReceivedWithinMonths: 12 },
  },
  {
    name: 'Life Jacket Safety Programme 2026',
    code: 'LJP-2026',
    type: PROGRAMME_TYPES.LIFE_JACKET_PROGRAMME,
    year: 2026,
    status: PROGRAMME_STATUS.OPEN,
    itemDescription: 'Approved marine life jacket',
    unitValue: 28_000,
    targetBeneficiaries: 3000,
    eligibility: { requiresVerifiedBlueId: true },
  },
  {
    name: 'Women in Fish Processing Grant 2026',
    code: 'WFP-2026',
    type: PROGRAMME_TYPES.GRANT,
    year: 2026,
    status: PROGRAMME_STATUS.DRAFT,
    itemDescription: 'Processing grant and smoking kiln',
    unitValue: 350_000,
    targetBeneficiaries: 400,
    eligibility: {
      genders: ['FEMALE'],
      fishermanTypes: [FISHERMAN_TYPES.FISH_PROCESSOR, FISHERMAN_TYPES.FISH_TRADER],
      requiresVerifiedBlueId: true,
    },
  },
];

const COOPERATIVES = [
  { name: 'Anantigha Fishermen Multipurpose Cooperative', lga: 'CAS', registrationNumber: 'CRS-COOP-0012' },
  { name: 'Bakassi Artisanal Fishers Union', lga: 'BAK', registrationNumber: 'CRS-COOP-0034' },
  { name: 'Ikot Offiong Riverine Farmers Society', lga: 'ODU', registrationNumber: 'CRS-COOP-0057' },
];

async function seedCommunities() {
  let created = 0;
  for (const entry of COMMUNITIES) {
    const result = await Community.updateOne(
      { lga: entry.lga, name: entry.name },
      {
        $setOnInsert: {
          ...entry,
          facilities: {
            landingSite: false,
            coldStorage: false,
            iceplant: false,
            processingFacility: false,
            boatRepair: false,
            jetty: false,
            market: false,
            ...entry.facilities,
          },
          normalizedName: require('../utils/normalize').normalizeText(entry.name),
          isActive: true,
        },
      },
      { upsert: true }
    );
    if (result.upsertedCount) created += 1;
  }
  return created;
}

async function seedProgrammes(createdBy) {
  let created = 0;
  for (const entry of PROGRAMMES) {
    const result = await Programme.updateOne(
      { code: entry.code },
      { $setOnInsert: { ...entry, createdBy } },
      { upsert: true }
    );
    if (result.upsertedCount) created += 1;
  }
  return created;
}

async function seedCooperatives() {
  let created = 0;
  for (const entry of COOPERATIVES) {
    const result = await Cooperative.updateOne(
      { lga: entry.lga, name: entry.name },
      {
        $setOnInsert: {
          ...entry,
          normalizedName: require('../utils/normalize').normalizeText(entry.name),
          isActive: true,
        },
      },
      { upsert: true }
    );
    if (result.upsertedCount) created += 1;
  }
  return created;
}

/**
 * Development super administrator.
 * Created without an `authUid`: the account binds to a real identity the first
 * time someone signs in through the client's identity provider with this email.
 */
async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@blueid.local';

  const existing = await User.findOne({ email });
  if (existing) return { user: existing, created: false };

  const passwordUtil = require('../utils/password');
  const plaintext = process.env.SEED_ADMIN_PASSWORD || passwordUtil.generateTemporary();

  const user = await User.create({
    email,
    firstName: 'Blue ID',
    lastName: 'Administrator',
    role: ROLES.SUPER_ADMIN,
    status: USER_STATUS.ACTIVE,
    scope: { lgas: [], communities: [] }, // state-wide
    designation: 'System Administrator',
    passwordHash: await passwordUtil.hash(plaintext),
    passwordChangedAt: new Date(),
    mustChangePassword: !process.env.SEED_ADMIN_PASSWORD,
  });

  return { user, created: true, plaintext };
}

async function reset() {
  if (config.isProduction) {
    throw new Error('Refusing to reset data in production');
  }
  logger.warn('Resetting operational collections');
  await Promise.all([
    Fisherman.deleteMany({}),
    Boat.deleteMany({}),
    Engine.deleteMany({}),
    // Benefit history is guarded against ODM deletes; a dev reset goes
    // through the driver on purpose.
    Allocation.collection.deleteMany({}),
    SyncBatch.deleteMany({}),
    Device.deleteMany({}),
    Counter.deleteMany({}),
  ]);
}

async function run() {
  const shouldReset = process.argv.includes('--reset');

  await database.connect();

  if (shouldReset) await reset();

  const adminResult = await seedAdmin();
  const { user: admin, created: adminCreated } = adminResult;
  const [communities, programmes, cooperatives] = await Promise.all([
    seedCommunities(),
    seedProgrammes(admin._id),
    seedCooperatives(),
  ]);

  if (adminCreated && adminResult.plaintext && !process.env.SEED_ADMIN_PASSWORD) {
    process.stdout.write(
      `\n  Seed administrator\n  Email:    ${admin.email}\n  Password: ${adminResult.plaintext}\n\n`
    );
  }

  logger.info(
    {
      admin: adminCreated ? `created (${admin.email})` : `exists (${admin.email})`,
      communitiesCreated: communities,
      programmesCreated: programmes,
      cooperativesCreated: cooperatives,
      reset: shouldReset,
    },
    'Seed complete'
  );

  logger.warn(
    'Seeded communities are an illustrative starter set — replace them with the official register before go-live.'
  );

  await database.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  logger.fatal({ err }, 'Seed failed');
  await database.disconnect().catch(() => {});
  process.exit(1);
});
