'use strict';

/**
 * Media storage.
 *
 * This deployment stores every image on Cloudinary, so that is the only
 * driver here. `media.service.js` is written against this module rather than
 * against Cloudinary directly, which keeps the seam that made swapping
 * possible in the first place — a filesystem driver lives on the
 * postgres-migration branch for a deployment that must keep citizen
 * photographs inside Nigeria, and dropping it back in means adding a file
 * and a branch in this one.
 */

module.exports = require('./cloudinary.driver');
