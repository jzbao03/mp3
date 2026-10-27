const { ApiError } = require('./errors');
function invalid(name) { throw new ApiError(400, `Invalid ${name} query parameter.`); }
function parse(query, name, fallback) {
  if (query[name] === undefined) return fallback;
  if (typeof query[name] !== 'string') invalid(name);
  try { return JSON.parse(query[name]); } catch { invalid(name); }
}
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(name);
  return value;
}
function safeFilter(value) {
  if (!value || typeof value !== 'object') return;
  const operators = new Set([
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
    '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
    '$all', '$elemMatch', '$size', '$mod', '$bitsAllClear', '$bitsAllSet',
    '$bitsAnyClear', '$bitsAnySet', '$comment',
  ]);
  for (const [key, child] of Object.entries(value)) {
    if ((key.startsWith('$') && !operators.has(key)) ||
        ['__proto__', 'constructor', 'prototype'].includes(key)) invalid('where');
    safeFilter(child);
  }
}
function projection(query) {
  const value = object(parse(query, 'select', {}), 'select');
  let mode;
  for (const [key, flag] of Object.entries(value)) {
    if (!/^[A-Za-z_][\w.]*$/.test(key) || ![0, 1].includes(flag)) invalid('select');
    if (key !== '_id') {
      if (mode !== undefined && mode !== flag) invalid('select');
      mode = flag;
    }
  }
  return value;
}
function collectionOptions(query, task) {
  const where = object(parse(query, 'where', {}), 'where');
  safeFilter(where);
  const sort = object(parse(query, 'sort', {}), 'sort');
  for (const [key, direction] of Object.entries(sort)) {
    if (!/^[A-Za-z_][\w.]*$/.test(key) || ![1, -1].includes(direction)) invalid('sort');
  }
  const select = projection(query);
  const skip = parse(query, 'skip', 0);
  const limit = parse(query, 'limit', task ? 100 : 0);
  for (const [name, value] of [['skip', skip], ['limit', limit]]) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(name);
  }
  const count = parse(query, 'count', false);
  if (typeof count !== 'boolean') invalid('count');
  return { where, sort, select, skip, limit, count };
}
module.exports = { projection, collectionOptions };
