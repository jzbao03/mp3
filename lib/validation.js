const { ApiError } = require('./errors');

function validId(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function invalidField(message) {
  throw new ApiError(400, message);
}

function text(value, field, required = false) {
  if (typeof value !== 'string' || (required && !value.trim())) {
    invalidField(`${field} must be ${required ? 'a non-empty' : 'a'} string.`);
  }
  return required ? value.trim() : value;
}

function requireBodyObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalidField('The request body must be an object.');
  }
}

function parseDeadline(value) {
  const isDateInput = typeof value === 'string' || typeof value === 'number';
  if (!isDateInput || (typeof value === 'string' && !value.trim())) {
    invalidField('deadline must be a valid date.');
  }

  const deadline = new Date(value);
  if (!Number.isFinite(deadline.getTime())) {
    invalidField('deadline must be a valid date.');
  }
  return deadline;
}

function userFields(body, isForm) {
  requireBodyObject(body);

  const name = text(body.name, 'name', true);
  const email = text(body.email, 'email', true);
  let pendingTaskIds = Object.hasOwn(body, 'pendingTasks') ? body.pendingTasks : [];

  if (isForm && typeof pendingTaskIds === 'string') {
    try {
      pendingTaskIds = JSON.parse(pendingTaskIds);
    } catch {
      invalidField('pendingTasks must be an array of task IDs.');
    }
  }

  if (!Array.isArray(pendingTaskIds) || pendingTaskIds.some((id) => !validId(id))) {
    invalidField('pendingTasks must be an array of valid task IDs.');
  }

  const pendingTasks = [...new Set(pendingTaskIds.map((id) => id.toLowerCase()))];
  return { name, email, pendingTasks };
}

function taskFields(body, isForm) {
  requireBodyObject(body);

  const name = text(body.name, 'name', true);
  const deadline = parseDeadline(body.deadline);
  const description = Object.hasOwn(body, 'description')
    ? text(body.description, 'description')
    : '';

  let completed = Object.hasOwn(body, 'completed') ? body.completed : false;
  if (isForm && ['true', 'false'].includes(completed)) {
    completed = completed === 'true';
  }
  if (typeof completed !== 'boolean') {
    invalidField('completed must be a boolean.');
  }

  let assignedUser = Object.hasOwn(body, 'assignedUser') ? body.assignedUser : '';
  if (assignedUser !== '' && !validId(assignedUser)) {
    invalidField('assignedUser must be a valid user ID or an empty string.');
  }
  if (assignedUser) {
    assignedUser = assignedUser.toLowerCase();
  }

  const assignedUserName = Object.hasOwn(body, 'assignedUserName')
    ? text(body.assignedUserName, 'assignedUserName')
    : undefined;

  if (
    !assignedUser &&
    assignedUserName !== undefined &&
    assignedUserName !== 'unassigned'
  ) {
    invalidField('An unassigned task must have assignedUserName "unassigned".');
  }

  return { name, deadline, description, completed, assignedUser, assignedUserName };
}

module.exports = { validId, userFields, taskFields };
