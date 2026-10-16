'use strict';

const express = require('express');
const controller = require('./dashboard.controller');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { PERMISSIONS } = require('../../config/constants');

const router = express.Router();

router.use(authenticate);
// Aggregates are management information: an enumerator captures data, they do
// not get a state-wide view of it.
router.use(requirePermission(PERMISSIONS.DASHBOARD_VIEW));
// Figures are always scoped to the caller's LGAs inside the service.
const q = validate({ query: controller.dashboardQuery });

router.get('/summary', q, controller.summary);
router.get('/communities', q, controller.byCommunity);
router.get('/infrastructure-gaps', q, controller.infrastructureGaps);
router.get('/trend', q, controller.trend);
router.get('/capacity', q, controller.capacity);
router.get('/programmes', q, controller.programmePerformance);

/** Staff productivity is management information — administrators only. */
router.get('/enumerators', requirePermission(PERMISSIONS.AUDIT_READ), q, controller.enumeratorActivity);

module.exports = router;
