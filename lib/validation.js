const { ApiError } = require('./errors');
const own = (object, key) => Object.hasOwn(object, key);
const validId = (value) => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
const canonicalId = (value) => value.toLowerCase();
const bad = (message) => { throw new ApiError(400, message); };
function text(value, field, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) {
    bad(`${field} must be ${required ? 'a non-empty' : 'a'} string.`);
  }
  return required ? value.trim() : value;
}
function bodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) bad('The request body must be an object.');
}
function userFields(body, form) {
  bodyObject(body);
  const name = text(body.name, 'name', true);
  const email = text(body.email, 'email', true);
  let pending = own(body, 'pendingTasks') ? body.pendingTasks : [];
  if (form && typeof pending === 'string') {
    try { pending = JSON.parse(pending); } catch { bad('pendingTasks must be an array of task IDs.'); }
  }
  if (!Array.isArray(pending) || pending.some((id) => !validId(id))) bad('pendingTasks must be an array of valid task IDs.');
  return { name, email, pendingTasks: [...new Set(pending.map(canonicalId))] };
}
function taskFields(body, form) {
  bodyObject(body);
  const name = text(body.name, 'name', true);
  const deadlineValue = body.deadline;
  if (!['string', 'number'].includes(typeof deadlineValue) ||
      (typeof deadlineValue === 'string' && !deadlineValue.trim())) bad('deadline must be a valid date.');
  const deadline = new Date(deadlineValue);
  if (!Number.isFinite(deadline.getTime())) bad('deadline must be a valid date.');
  const description = own(body, 'description') ? text(body.description, 'description') : '';
  let completed = own(body, 'completed') ? body.completed : false;
  if (form && ['true', 'false'].includes(completed)) completed = completed === 'true';
  if (typeof completed !== 'boolean') bad('completed must be a boolean.');
  let assignedUser = own(body, 'assignedUser') ? body.assignedUser : '';
  if (assignedUser !== '' && !validId(assignedUser)) bad('assignedUser must be a valid user ID or an empty string.');
  if (assignedUser) assignedUser = canonicalId(assignedUser);
  const assignedUserName = own(body, 'assignedUserName') ? text(body.assignedUserName, 'assignedUserName') : undefined;
  if (!assignedUser && assignedUserName !== undefined && assignedUserName !== 'unassigned') {
    bad('An unassigned task must have assignedUserName "unassigned".');
  }
  return { name, deadline, description, completed, assignedUser, assignedUserName };
}
module.exports = { validId, userFields, taskFields };
