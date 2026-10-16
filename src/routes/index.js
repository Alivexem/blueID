'use strict';

const express = require('express');

const healthRoutes = require('../modules/health/health.routes');
const authRoutes = require('../modules/auth/auth.routes');
const userRoutes = require('../modules/users/user.routes');
const fishermanRoutes = require('../modules/fishermen/fisherman.routes');
const { boatRoutes, engineRoutes, equipmentRoutes, ownerRoutes } =
  require('../modules/assets/asset.routes');
const communityRoutes = require('../modules/communities/community.routes');
const cooperativeRoutes = require('../modules/cooperatives/cooperative.routes');
const programmeRoutes = require('../modules/programmes/programme.routes');
const syncRoutes = require('../modules/sync/sync.routes');
const verificationRoutes = require('../modules/verification/verification.routes');
const dashboardRoutes = require('../modules/dashboard/dashboard.routes');
const gisRoutes = require('../modules/gis/gis.routes');
const reportRoutes = require('../modules/reports/report.routes');
const mediaRoutes = require('../modules/media/media.routes');
const auditRoutes = require('../modules/audit/audit.routes');

const config = require('../config');
const { LGAS, ROLES, FISHERMAN_TYPES, FISHING_TYPES, BOAT_TYPES, EQUIPMENT_TYPES, PROGRAMME_TYPES, FISHERMAN_STATUS } =
  require('../config/constants');

const router = express.Router();

/** API index — what a developer hitting the base URL should see. */
router.get('/', (req, res) => {
  res.json({
    name: 'Cross River State Blue ID & Fisheries Information Management System',
    version: require('../../package.json').version,
    environment: config.env,
    documentation: `${config.app.baseUrl}/docs`,
    endpoints: {
      health: '/health',
      auth: `${config.app.apiPrefix}/auth`,
      users: `${config.app.apiPrefix}/users`,
      fishermen: `${config.app.apiPrefix}/fishermen`,
      boats: `${config.app.apiPrefix}/boats`,
      engines: `${config.app.apiPrefix}/engines`,
      equipment: `${config.app.apiPrefix}/equipment`,
      communities: `${config.app.apiPrefix}/communities`,
      cooperatives: `${config.app.apiPrefix}/cooperatives`,
      programmes: `${config.app.apiPrefix}/programmes`,
      sync: `${config.app.apiPrefix}/sync`,
      verify: `${config.app.apiPrefix}/verify`,
      dashboard: `${config.app.apiPrefix}/dashboard`,
      gis: `${config.app.apiPrefix}/gis`,
      reports: `${config.app.apiPrefix}/reports`,
      media: `${config.app.apiPrefix}/media`,
      audit: `${config.app.apiPrefix}/audit`,
    },
  });
});

/**
 * Enumerations and the LGA list, so the portal and the field app build their
 * dropdowns from the server's vocabulary rather than hard-coding their own.
 */
router.get('/reference/constants', (req, res) => {
  res.json({
    success: true,
    data: {
      lgas: LGAS,
      roles: ROLES,
      fishermanTypes: FISHERMAN_TYPES,
      fishingTypes: FISHING_TYPES,
      boatTypes: BOAT_TYPES,
      equipmentTypes: EQUIPMENT_TYPES,
      programmeTypes: PROGRAMME_TYPES,
      fishermanStatus: FISHERMAN_STATUS,
      blueIdFormat: `${config.blueId.prefix}-${config.blueId.segment}-<LGA>-${'0'.repeat(config.blueId.padding)}`,
    },
  });
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/fishermen', fishermanRoutes);
router.use('/boats', boatRoutes);
router.use('/engines', engineRoutes);
router.use('/equipment', equipmentRoutes);
router.use('/assets', ownerRoutes);
router.use('/communities', communityRoutes);
router.use('/cooperatives', cooperativeRoutes);
router.use('/programmes', programmeRoutes);
router.use('/sync', syncRoutes);
router.use('/verify', verificationRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/gis', gisRoutes);
router.use('/reports', reportRoutes);
router.use('/media', mediaRoutes);
router.use('/audit', auditRoutes);

module.exports = { apiRouter: router, healthRoutes };
