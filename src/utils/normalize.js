'use strict';

/**
 * Normalisation helpers.
 *
 * Field data is entered by hand, often on a phone, in communities where the
 * same name has several accepted spellings. Every value we match or
 * de-duplicate on is stored twice: as typed (for display) and normalised (for
 * comparison). These functions produce the normalised half and must stay
 * deterministic — changing one means rebuilding the derived fields.
 */

const NG_COUNTRY_CODE = '234';

/**
 * Nigerian MSISDN -> E.164.
 *   08031234567 / 8031234567 / 2348031234567 / +234 803 123 4567
 *     -> +2348031234567
 * Returns null when the input cannot be read as a Nigerian mobile number, so
 * callers can keep the raw value without poisoning the match index.
 */
function normalizePhone(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');
  if (!digits) return null;

  // Strip international dialling prefixes.
  if (digits.startsWith('00')) digits = digits.slice(2);

  if (digits.startsWith(NG_COUNTRY_CODE) && digits.length === 13) {
    return `+${digits}`;
  }
  if (digits.startsWith('0') && digits.length === 11) {
    return `+${NG_COUNTRY_CODE}${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    return `+${NG_COUNTRY_CODE}${digits}`;
  }
  // Non-Nigerian but plausible international number — keep it in E.164 shape.
  if (digits.length > 13 && digits.length <= 15) return `+${digits}`;

  return null;
}

function isValidNigerianMobile(input) {
  const normalized = normalizePhone(input);
  // Nigerian mobile prefixes after the country code: 70, 80, 81, 90, 91...
  return Boolean(normalized && /^\+234[789][01]\d{8}$/.test(normalized));
}

/** NIN is 11 digits. Returns null if it cannot be one. */
function normalizeNin(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  return digits.length === 11 ? digits : null;
}

/**
 * Lower-cased, accent-stripped, punctuation-free, single-spaced.
 * "O'Brien-Effiom,  Ntufam " -> "obrien effiom ntufam"
 */
function normalizeText(input) {
  if (!input) return '';
  return String(input)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Honorifics carry no identity information and appear inconsistently in the
 * field ("Chief Effiom" vs "Effiom"), so they are dropped before matching.
 */
const TITLES = new Set([
  'mr', 'mrs', 'miss', 'ms', 'dr', 'engr', 'chief', 'pastor', 'rev', 'reverend',
  'alhaji', 'alhaja', 'elder', 'hon', 'honourable', 'sir', 'madam', 'ntufam',
  'obong', 'etubom', 'prince', 'princess', 'capt', 'captain',
]);

/**
 * Canonical form used by the duplicate index: titles removed, tokens sorted so
 * "Effiom Okon" and "Okon Effiom" collide.
 */
function normalizeName(input) {
  const tokens = normalizeText(input)
    .split(' ')
    .filter((t) => t && !TITLES.has(t));
  return tokens.sort().join(' ');
}

/** Same as normalizeName but keeps the given word order. */
function normalizeNameOrdered(input) {
  return normalizeText(input)
    .split(' ')
    .filter((t) => t && !TITLES.has(t))
    .join(' ');
}

/** "effiom  okon " -> "Effiom Okon" */
function toTitleCase(input) {
  if (!input) return '';
  return String(input)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b[\p{L}'’-]+/gu, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function buildFullName({ firstName, middleName, lastName }) {
  return [firstName, middleName, lastName].map((p) => (p || '').trim()).filter(Boolean).join(' ');
}

/** Uppercase, alphanumerics and dashes only — boat/engine registration numbers. */
function normalizeCode(input) {
  if (!input) return null;
  const code = String(input).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return code || null;
}

/** Trims every string in an object, turning "" into undefined. */
function trimStrings(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      out[key] = trimmed === '' ? undefined : trimmed;
    } else if (value && typeof value === 'object' && !(value instanceof Date)) {
      out[key] = trimStrings(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Many fishermen do not know their exact date of birth; enumerators record an
 * estimated year instead. Both resolve to a comparable year for matching and
 * age statistics.
 */
function resolveBirthYear({ dateOfBirth, estimatedYearOfBirth }) {
  if (dateOfBirth) {
    const date = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
    if (!Number.isNaN(date.getTime())) return date.getUTCFullYear();
  }
  return estimatedYearOfBirth ?? null;
}

module.exports = {
  normalizePhone,
  isValidNigerianMobile,
  normalizeNin,
  normalizeText,
  normalizeName,
  normalizeNameOrdered,
  normalizeCode,
  toTitleCase,
  buildFullName,
  trimStrings,
  resolveBirthYear,
  TITLES,
};
