'use strict';

const { z } = require('zod');
const service = require('./dashboard.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok } = require('../../utils/response');
const { LGA_CODES } = require('../../config/constants');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);

const dashboardQuery = z.object({
  lga: z.enum(LGA_CODES).optional(),
  community: objectId.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  granularity: z.enum(['day', 'week', 'month']).optional(),
  waterfrontOnly: z.coerce.boolean().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

const summary = asyncHandler(async (req, res) => {
  const data = await service.summary(req.query, req.user);
  return ok(res, data);
});

const byCommunity = asyncHandler(async (req, res) => {
  const data = await service.byCommunity(req.query, req.user);
  return ok(res, data);
});

const infrastructureGaps = asyncHandler(async (req, res) => {
  const data = await service.infrastructureGaps(req.query, req.user);
  return ok(res, data);
});

const trend = asyncHandler(async (req, res) => {
  const data = await service.registrationTrend(req.query, req.user);
  return ok(res, data);
});

const enumeratorActivity = asyncHandler(async (req, res) => {
  const data = await service.enumeratorActivity(req.query, req.user);
  return ok(res, data);
});

const capacity = asyncHandler(async (req, res) => {
  const data = await service.capacityByLga(req.query, req.user);
  return ok(res, data);
});

const programmePerformance = asyncHandler(async (req, res) => {
  const data = await service.programmePerformance(req.query, req.user);
  return ok(res, data);
});

module.exports = {
  dashboardQuery,
  summary,
  byCommunity,
  infrastructureGaps,
  trend,
  enumeratorActivity,
  capacity,
  programmePerformance,
};
