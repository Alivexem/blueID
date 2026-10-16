'use strict';

const express = require('express');
const { z } = require('zod');
const service = require('./report.service');
const asyncHandler = require('../../utils/asyncHandler');
const { validate } = require('../../middleware/validate');
const { authenticate } = require('../../middleware/authenticate');
const { requirePermission } = require('../../middleware/authorize');
const { exportLimiter } = require('../../middleware/rateLimiter');
const {
  PERMISSIONS,
  LGA_CODES,
  FISHERMAN_STATUS,
  GENDERS,
  FISHERMAN_TYPES,
  ALLOCATION_STATUS,
} = require('../../config/constants');

const router = express.Router();

router.use(authenticate);
// Exports remove personal data from the system — administrators only, and
// rate limited because each one scans a large slice of the register.
router.use(requirePermission(PERMISSIONS.REPORT_EXPORT));
router.use(exportLimiter);

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const exportQuery = z.object({
  lga: z.enum(LGA_CODES).optional(),
  community: objectId.optional(),
  status: z.enum(Object.values(FISHERMAN_STATUS)).optional(),
  gender: z.enum(Object.values(GENDERS)).optional(),
  fishermanType: z.enum(Object.values(FISHERMAN_TYPES)).optional(),
  hasBlueId: z.coerce.boolean().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const beneficiaryQuery = z.object({
  status: z.enum(Object.values(ALLOCATION_STATUS)).optional(),
});

/** GET /reports/register.csv */
router.get(
  '/register.csv',
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    await service.streamRegisterCsv(req.query, req.user, res, { req });
  })
);

/** GET /reports/register.xlsx */
router.get(
  '/register.xlsx',
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    await service.streamRegisterExcel(req.query, req.user, res, { req });
  })
);

/** GET /reports/statistics.xlsx — multi-sheet analytical workbook. */
router.get(
  '/statistics.xlsx',
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    await service.streamStatisticsExcel(req.query, req.user, res, { req });
  })
);

/** GET /reports/summary.pdf — executive summary for circulation. */
router.get(
  '/summary.pdf',
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    await service.streamSummaryPdf(req.query, req.user, res, { req });
  })
);

/** GET /reports/boats.csv and /reports/engines.csv */
router.get(
  '/boats.csv',
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    await service.streamAssetsCsv('BOAT', req.query, req.user, res, { req });
  })
);

router.get(
  '/engines.csv',
  validate({ query: exportQuery }),
  asyncHandler(async (req, res) => {
    await service.streamAssetsCsv('ENGINE', req.query, req.user, res, { req });
  })
);

/** GET /reports/programmes/:id/beneficiaries.csv */
router.get(
  '/programmes/:id/beneficiaries.csv',
  validate({ params: z.object({ id: objectId }), query: beneficiaryQuery }),
  asyncHandler(async (req, res) => {
    await service.streamBeneficiariesCsv(req.params.id, req.query, req.user, res, { req });
  })
);

module.exports = router;
