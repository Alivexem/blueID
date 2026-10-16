'use strict';

const { v2: cloudinary } = require('cloudinary');
const config = require('./index');
const logger = require('./logger');

/**
 * Cloudinary holds every image in the system: passport photographs, boat
 * photos and delivery acknowledgement slips.
 *
 * Images of registered citizens are not public assets — uploads go to an
 * `authenticated` delivery type so a leaked URL alone cannot expose a
 * fisherman's photograph. Read access is granted per-request via short-lived
 * signed URLs (see services/media.service.js).
 */

if (config.cloudinary.enabled) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true,
  });
  logger.info({ folder: config.cloudinary.folder }, 'Cloudinary configured');
} else {
  const message = 'Cloudinary not configured — media endpoints will return 503';
  if (config.isProduction) logger.error(message);
  else logger.warn(message);
}

/** Folder layout keeps assets browsable per LGA in the Cloudinary console. */
const FOLDERS = Object.freeze({
  fishermanPhoto: (lga) => `${config.cloudinary.folder}/fishermen/${lga || 'unassigned'}`,
  boatPhoto: (lga) => `${config.cloudinary.folder}/boats/${lga || 'unassigned'}`,
  equipmentPhoto: (lga) => `${config.cloudinary.folder}/equipment/${lga || 'unassigned'}`,
  acknowledgement: (programmeCode) => `${config.cloudinary.folder}/allocations/${programmeCode}`,
  idCard: () => `${config.cloudinary.folder}/id-cards`,
});

/** Passport photos are normalised on upload: square, face-centred, ~400px. */
const PASSPORT_TRANSFORMATION = Object.freeze([
  { width: 400, height: 400, crop: 'fill', gravity: 'face' },
  { quality: 'auto:good', fetch_format: 'auto' },
]);

module.exports = {
  cloudinary,
  FOLDERS,
  PASSPORT_TRANSFORMATION,
  isEnabled: () => config.cloudinary.enabled,
};
