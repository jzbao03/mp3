const { ApiError } = require('./errors');

const blockedFilterKeys = new Set([
  '$where',
  '$function',
  '$accumulator',
  '__proto__',
  'constructor',
  'prototype',
]);

function invalidQuery(name) {
  throw new ApiError(400, `Invalid ${name} query parameter.`);
}

function parseParameter(query, name, fallback) {
  if (query[name] === undefined) {
    return fallback;
  }
  if (typeof query[name] !== 'string') {
    invalidQuery(name);
  }

  try {
    return JSON.parse(query[name]);
  } catch {
    invalidQuery(name);
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalidQuery(name);
  }
  return value;
}

function validateFilter(value) {
  if (!value || typeof value !== 'object') {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    // Allow ordinary MongoDB expressions, but not server-side JavaScript.
    if (blockedFilterKeys.has(key)) {
      invalidQuery('where');
    }
    validateFilter(child);
  }
}

function validPath(path) {
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_0-9]\w*)*$/.test(path);
}

function projection(query) {
  const fields = requireObject(parseParameter(query, 'select', {}), 'select');
  const paths = new Set(Object.keys(fields));
  let mode;

  for (const [path, flag] of Object.entries(fields)) {
    if (!validPath(path) || ![0, 1].includes(flag)) {
      invalidQuery('select');
    }

    // Selecting a parent and its child together is a MongoDB path collision.
    const segments = path.split('.');
    for (let end = 1; end < segments.length; end++) {
      if (paths.has(segments.slice(0, end).join('.'))) {
        invalidQuery('select');
      }
    }

    // MongoDB allows _id to be excluded from an otherwise inclusive projection.
    if (path !== '_id') {
      if (mode !== undefined && mode !== flag) {
        invalidQuery('select');
      }
      mode = flag;
    }
  }

  return fields;
}

function collectionOptions(query, isTaskCollection) {
  const where = requireObject(parseParameter(query, 'where', {}), 'where');
  validateFilter(where);

  const sort = requireObject(parseParameter(query, 'sort', {}), 'sort');
  for (const [path, direction] of Object.entries(sort)) {
    if (!validPath(path) || ![1, -1].includes(direction)) {
      invalidQuery('sort');
    }
  }

  const select = projection(query);
  const skip = parseParameter(query, 'skip', 0);
  const limit = parseParameter(query, 'limit', isTaskCollection ? 100 : 0);

  for (const [name, value] of [
    ['skip', skip],
    ['limit', limit],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      invalidQuery(name);
    }
  }

  const count = parseParameter(query, 'count', false);
  if (typeof count !== 'boolean') {
    invalidQuery('count');
  }

  return { where, sort, select, skip, limit, count };
}

function castFilter(query, Model) {
  // Cast separately so malformed filters are 400s; a failed DB read must stay a 500.
  try {
    query.cast(Model);
  } catch {
    invalidQuery('where');
  }
  return query;
}

module.exports = { projection, collectionOptions, castFilter };
