'use strict';

const service = require('./sync.service');
const asyncHandler = require('../../utils/asyncHandler');
const { ok, created, paginated } = require('../../utils/response');

const registerDevice = asyncHandler(async (req, res) => {
  const { device, secret } = await service.registerDevice(req.body, req.user, { req });
  return created(
    res,
    {
      device,
      // Shown once and never retrievable again.
      syncSecret: secret,
    },
    { message: 'Device registered. Store the sync secret now — it will not be shown again.' }
  );
});

const listDevices = asyncHandler(async (req, res) => {
  const { items, pagination } = await service.listDevices(req.query);
  return paginated(res, items, pagination);
});

const revokeDevice = asyncHandler(async (req, res) => {
  const device = await service.revokeDevice(req.params.id, req.body, req.user, { req });
  return ok(res, device, { message: 'Device revoked' });
});

/**
 * Receives a batch of offline records.
 *
 * Always 200 (or 201 on first processing) even when individual records fail —
 * the per-record outcomes are the payload. A non-2xx would make the device
 * retry the whole batch, including records that were already stored.
 */
const push = asyncHandler(async (req, res) => {
  const { batch, replayed } = await service.push(req.body, req.user, { req });

  const payload = {
    batchId: batch._id,
    clientBatchId: batch.clientBatchId,
    status: batch.status,
    counts: batch.counts,
    results: batch.results,
    replayed,
    serverTime: new Date(),
  };

  const message = replayed
    ? 'This batch was already processed — returning the original result'
    : `${batch.counts.created} created, ${batch.counts.updated} updated, ${batch.counts.rejected} rejected`;

  return replayed ? ok(res, payload, { message }) : created(res, payload, { message });
});

/**
 * Device credentials may arrive as headers or in the query/body. Headers are
 * preferred for GETs so the secret never lands in a URL (and therefore never
 * in an access log).
 */
function withDeviceCredentials(req) {
  return {
    ...req.query,
    deviceCode: req.query.deviceCode || req.get('x-device-id') || undefined,
    deviceSecret: req.query.deviceSecret || req.get('x-device-secret') || undefined,
  };
}

const pull = asyncHandler(async (req, res) => {
  const result = await service.pull(withDeviceCredentials(req), req.user, { req });
  return ok(res, result);
});

const bootstrap = asyncHandler(async (req, res) => {
  const result = await service.bootstrap(withDeviceCredentials(req), req.user);
  return ok(res, result);
});

const listBatches = asyncHandler(async (req, res) => {
  const { items, pagination } = await service.listBatches(req.query, req.user);
  return paginated(res, items, pagination);
});

/** Retrieves the payloads of records the server could not accept. */
const getRejectedRecords = asyncHandler(async (req, res) => {
  const result = await service.getRejectedRecords(req.params.id, req.user, { req });
  return ok(res, result, {
    message: 'Correct these records and resubmit them as a new batch',
  });
});

const getBatch = asyncHandler(async (req, res) => {
  const batch = await service.getBatch(req.params.id);
  return ok(res, batch);
});

/** Lightweight probe the app calls before attempting a sync. */
const status = asyncHandler(async (req, res) => {
  return ok(res, {
    online: true,
    serverTime: new Date(),
    maxBatchSize: require('../../config').sync.maxBatchSize,
    conflictStrategy: require('../../config').sync.conflictStrategy,
  });
});

module.exports = {
  registerDevice,
  listDevices,
  revokeDevice,
  push,
  pull,
  bootstrap,
  listBatches,
  getBatch,
  getRejectedRecords,
  status,
};
