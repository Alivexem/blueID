'use strict';

const config = require('../../config');
const logger = require('../../config/logger');

/**
 * Picks the storage driver named by MEDIA_DRIVER.
 *
 * Selected once at load rather than per call: switching stores under a
 * running process would leave half the day's uploads in one place and half in
 * the other, with nothing recording which went where.
 */

const drivers = {
  local: () => require('./local.driver'),
  cloudinary: () => require('./cloudinary.driver'),
};

const factory = drivers[config.media.driver];

if (!factory) {
  throw new Error(
    `Unknown MEDIA_DRIVER "${config.media.driver}" — expected one of: ${Object.keys(drivers).join(', ')}`
  );
}

const driver = factory();

logger.info(
  { driver: driver.name, ...(driver.name === 'local' ? { root: config.media.root } : {}) },
  'Media storage driver selected'
);

module.exports = driver;
