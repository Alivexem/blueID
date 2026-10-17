'use strict';

const database = require('../config/database');

/**
 * Small SQL helpers shared by the repositories.
 *
 * Deliberately NOT a query builder and not an ORM. The register's queries
 * are written as SQL in the repository that owns them, because the ones that
 * matter — duplicate blocking, the sync cursor, the dashboard aggregates —
 * are precisely the ones a builder would obscure. What lives here is the
 * mechanical part: naming, placeholders, and turning rows into the shape the
 * rest of the application already expects.
 *
 * NAMING. Postgres columns are snake_case; the API, the field app and 189
 * existing tests speak camelCase. Rather than rename either, conversion
 * happens at this boundary, in one place.
 */

/** `first_name` -> `firstName` */
const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** `firstName` -> `first_name` */
const toSnake = (s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * Turns a row into the application's shape.
 *
 * `aliases` renames specific columns where the two vocabularies genuinely
 * differ rather than merely in case — a foreign key is `owner_id` in the
 * schema but has always been `owner` in the API, and renaming it in the
 * response would break every client for no benefit.
 *
 * Nulls are dropped. Mongo documents simply omitted absent fields, so a
 * response full of explicit nulls would be a visible change in the API for
 * every optional column in a 60-column table.
 */
function mapRow(row, { aliases = {}, keepNull = [] } = {}) {
  if (!row) return null;

  const out = {};
  for (const [column, value] of Object.entries(row)) {
    const key = aliases[column] || toCamel(column);
    if (value === null && !keepNull.includes(key)) continue;
    out[key] = value;
  }
  // `id` is the identifier everywhere in the API; `_id` is kept alongside it
  // so code and tests written against the Mongo shape keep working.
  if (out.id !== undefined) out._id = out.id;
  return out;
}

const mapRows = (rows, options) => rows.map((r) => mapRow(r, options));

/**
 * Collects values and emits `$1, $2, …` placeholders.
 *
 * Every value the application sends reaches Postgres as a bound parameter.
 * Nothing in a repository interpolates a value into SQL text, which is what
 * makes injection structurally impossible rather than a thing to remember.
 */
class Params {
  constructor() {
    this.values = [];
  }

  /** Binds a value and returns its placeholder. */
  add(value) {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** Binds each value of an array for an `IN (...)` list. */
  addList(values) {
    if (!values.length) return null;
    return values.map((v) => this.add(v)).join(', ');
  }
}

/**
 * Builds `INSERT ... RETURNING *` from an object keyed in camelCase.
 *
 * Unknown keys are dropped against the supplied column list rather than
 * passed through. A payload that has already been through Zod should contain
 * nothing unexpected, but a repository is the last place a stray key could
 * become a column, so it is also the right place to stop one.
 */
function buildInsert(table, data, columns, { aliases = {} } = {}) {
  const reverse = Object.fromEntries(Object.entries(aliases).map(([col, key]) => [key, col]));
  const params = new Params();
  const names = [];
  const placeholders = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const column = reverse[key] || toSnake(key);
    if (!columns.includes(column)) continue;
    names.push(`"${column}"`);
    placeholders.push(params.add(value));
  }

  if (!names.length) {
    throw new Error(`buildInsert(${table}): nothing to insert`);
  }

  return {
    text: `INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    values: params.values,
  };
}

/** Builds `UPDATE ... SET ... WHERE id = $n RETURNING *`. */
function buildUpdate(table, id, data, columns, { aliases = {} } = {}) {
  const reverse = Object.fromEntries(Object.entries(aliases).map(([col, key]) => [key, col]));
  const params = new Params();
  const sets = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const column = reverse[key] || toSnake(key);
    if (!columns.includes(column) || column === 'id') continue;
    sets.push(`"${column}" = ${params.add(value)}`);
  }

  if (!sets.length) return null;

  const idPlaceholder = params.add(id);
  return {
    text: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ${idPlaceholder} RETURNING *`,
    values: params.values,
  };
}

/**
 * Composes WHERE fragments.
 *
 * Fragments are strings the repository wrote, with their values already
 * bound through the same `Params`. Empty fragments are dropped so a caller
 * can build a list conditionally without worrying about stray ANDs.
 */
function where(...fragments) {
  const live = fragments.filter(Boolean);
  return live.length ? `WHERE ${live.join(' AND ')}` : '';
}

/** Runs a query and returns mapped rows. */
async function many(text, values, options = {}) {
  const { rows } = await database.query(text, values, options.client);
  return mapRows(rows, options);
}

/** Runs a query and returns the first mapped row, or null. */
async function one(text, values, options = {}) {
  const { rows } = await database.query(text, values, options.client);
  return rows.length ? mapRow(rows[0], options) : null;
}

/** Runs a query and returns the first column of the first row. */
async function scalar(text, values, client) {
  const { rows } = await database.query(text, values, client);
  if (!rows.length) return null;
  return Object.values(rows[0])[0];
}

/**
 * A page of rows plus the total.
 *
 * The count runs as a window function in the same statement rather than as a
 * second query, so the total cannot disagree with the page because something
 * was written in between.
 */
async function paginate({ select, from, whereClause = '', orderBy, limit, offset, values, ...options }) {
  const text = `
    SELECT ${select}, count(*) OVER () AS __total
    FROM ${from}
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${Number(limit)} OFFSET ${Number(offset)}
  `;

  const { rows } = await database.query(text, values, options.client);
  const total = rows.length ? Number(rows[0].__total) : 0;

  const items = rows.map((row) => {
    const { __total, ...rest } = row;
    return mapRow(rest, options);
  });

  return { items, total };
}

/**
 * An allowlist for `ORDER BY`.
 *
 * A sort field arriving from a query string is the one place a column name
 * could reach SQL as text rather than as a bound value, so it is matched
 * against known columns instead of being escaped.
 */
function resolveOrderBy(requested, allowed, fallback) {
  if (!requested) return fallback;

  const parts = String(requested)
    .split(',')
    .map((part) => {
      const descending = part.startsWith('-');
      const field = descending ? part.slice(1) : part;
      const column = allowed[field];
      return column ? `${column} ${descending ? 'DESC' : 'ASC'}` : null;
    })
    .filter(Boolean);

  return parts.length ? parts.join(', ') : fallback;
}

module.exports = {
  toCamel,
  toSnake,
  mapRow,
  mapRows,
  Params,
  buildInsert,
  buildUpdate,
  where,
  many,
  one,
  scalar,
  paginate,
  resolveOrderBy,
};
