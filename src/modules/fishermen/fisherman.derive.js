'use strict';

const fieldCrypto = require('../../utils/fieldCrypto');
const { normalizePhone, normalizeNin, normalizeName, toTitleCase } = require('../../utils/normalize');
const { phoneticNameKey } = require('../../utils/similarity');

/**
 * Derives everything about a fisherman that is computed rather than entered.
 *
 * This was a Mongoose `pre('validate')` hook. Moving it here is the point of
 * the change rather than a side effect of it: a hook fired invisibly on
 * save, so a service could not tell by reading itself whether the matching
 * keys it depended on had been computed — and a write path that used
 * `updateOne` instead of `save` silently skipped it, leaving a record that
 * duplicate detection could never match.
 *
 * Now it is a function the repository calls on every create and update, and
 * it is a plain transformation, so it can be tested without a database.
 *
 * WHAT IS DERIVED, AND WHY EACH ONE EXISTS
 *
 *   fullName         stored so it can be sorted, searched and exported
 *                    without recomputing it per row
 *   normalizedPhone  08031234567, +2348031234567 and 8031234567 are one
 *                    number; matching on the raw string would miss them
 *   ninIndex         a keyed HMAC, so two records can be compared on NIN
 *                    without the plaintext ever being queryable
 *   nin              AES-256-GCM ciphertext; the plaintext is never stored
 *   phoneticName     spelling varies by enumerator, so names are blocked on
 *                    sound rather than letters
 *   birthYear        a date of birth and an estimated year both reduce to a
 *                    year, which is the only part that matches reliably
 */
function deriveMatchKeys(row) {
  const derived = {};

  // Names are title-cased on the way in so the register does not hold
  // "ADA EFFIOM", "ada effiom" and "Ada Effiom" as three different people.
  if (row.firstName) derived.firstName = toTitleCase(row.firstName);
  if (row.middleName) derived.middleName = toTitleCase(row.middleName);
  if (row.lastName) derived.lastName = toTitleCase(row.lastName);

  const fullName = [
    derived.firstName ?? row.firstName,
    derived.middleName ?? row.middleName,
    derived.lastName ?? row.lastName,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (fullName) {
    derived.fullName = fullName;
    derived.normalizedName = normalizeName(fullName);
    derived.phoneticName = phoneticNameKey(derived.normalizedName);
  }

  if (row.phone !== undefined) derived.normalizedPhone = normalizePhone(row.phone) || null;
  if (row.altPhone !== undefined) derived.normalizedAltPhone = normalizePhone(row.altPhone) || null;

  /**
   * The NIN is normalised, blind-indexed, then encrypted in place.
   *
   * The ciphertext guard matters: without it, a second pass over an
   * already-encrypted value would encrypt the ciphertext, and the original
   * NIN would be unrecoverable — a silent, permanent data loss affecting
   * only the records that happened to be saved twice.
   */
  if (row.nin !== undefined && row.nin !== null) {
    if (fieldCrypto.isCiphertext(row.nin)) {
      derived.nin = row.nin;
    } else {
      const normalized = normalizeNin(row.nin);
      derived.ninIndex = normalized ? fieldCrypto.blindIndex(normalized) : null;
      derived.nin = normalized ? fieldCrypto.encrypt(normalized) : null;
    }
  }

  if (row.dateOfBirth || row.estimatedYearOfBirth) {
    const year = row.dateOfBirth
      ? new Date(row.dateOfBirth).getUTCFullYear()
      : Number(row.estimatedYearOfBirth);
    derived.birthYear = Number.isInteger(year) ? year : null;
  }

  if (row.status !== undefined) derived.statusChangedAt = new Date();

  return derived;
}

/** Decrypts the NIN for a caller entitled to see it. Never called by default. */
function revealNin(record) {
  if (!record?.nin) return null;
  try {
    return fieldCrypto.decrypt(record.nin);
  } catch {
    // A NIN that cannot be decrypted means the key changed. Returning null
    // rather than throwing keeps the rest of the record readable, and the
    // condition is visible in the response as an absent field.
    return null;
  }
}

module.exports = { deriveMatchKeys, revealNin };
