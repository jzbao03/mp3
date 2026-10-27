const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const os = require('node:os');
const path = require('node:path');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');
let database, server, base;
const absent = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const deadline = '2026-11-03T23:59:00.000Z';
const taskBody = (extra = {}) => ({ name: 'A task', deadline, ...extra });
const userBody = (extra = {}) => ({
  name: 'Alice',
  email: 'alice@example.com',
  ...extra,
});
async function request(
  path,
  method = 'GET',
  body,
  expected = method === 'DELETE' ? 204 : 200,
  headers = {}
) {
  const response = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined
      ? {}
      : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const value = response.status === 204 ? null : await response.json();
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  if (response.status === 204) assert.equal(await response.text(), '');
  if (value) {
    assert.equal(typeof value.message, 'string');
    assert.ok(Object.hasOwn(value, 'data'));
  }
  return value?.data;
}
const user = (extra) => request('/api/users', 'POST', userBody(extra), 201);
const task = (extra) => request('/api/tasks', 'POST', taskBody(extra), 201);
const query = (object) =>
  new URLSearchParams(
    Object.entries(object).map(([k, v]) => [k, JSON.stringify(v)])
  ).toString();
async function consistent() {
  const users = await User.find().lean();
  const tasks = await Task.find().lean();
  for (const u of users) {
    const expected = tasks
      .filter((t) => !t.completed && t.assignedUser === String(u._id))
      .map((t) => String(t._id))
      .sort();
    assert.deepEqual([...u.pendingTasks].sort(), expected);
  }
  for (const t of tasks) {
    if (!t.assignedUser) assert.equal(t.assignedUserName, 'unassigned');
    else
      assert.equal(
        t.assignedUserName,
        users.find((u) => String(u._id) === t.assignedUser)?.name
      );
  }
}
before(
  async () => {
    database = await MongoMemoryReplSet.create({
      binary: { downloadDir: path.join(os.tmpdir(), 'cs409-mp3-mongodb') },
      replSet: { count: 1 },
    });
    await mongoose.connect(database.getUri('mp3_test'));
    await User.init();
    await Task.init();
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  },
  { timeout: 180000 }
);
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  if (database) await database.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
  await Task.deleteMany({});
});

test('creation defaults, server-owned creation dates, health and CORS', async () => {
  const u = await user({ dateCreated: '2000-01-01', _id: absent });
  assert.notEqual(u._id, absent);
  assert.deepEqual(u.pendingTasks, []);
  assert.ok(new Date(u.dateCreated).getFullYear() >= 2026);
  const t = await task({ dateCreated: '2000-01-01' });
  assert.equal(t.description, '');
  assert.equal(t.completed, false);
  assert.equal(t.assignedUser, '');
  assert.equal(t.assignedUserName, 'unassigned');
  assert.ok(new Date(t.dateCreated).getFullYear() >= 2026);
  await request('/health');
  const preflight = await fetch(base + '/api/tasks', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
  await consistent();
});
test('required fields and wrong types are rejected without creating resources', async () => {
  for (const body of [
    {},
    { name: 'x' },
    { email: 'x' },
    userBody({ name: 4 }),
    userBody({ email: null }),
    userBody({ pendingTasks: 'bad' }),
    userBody({ pendingTasks: [4] }),
    userBody({ name: '  ' }),
  ]) {
    await request('/api/users', 'POST', body, 400);
  }
  for (const body of [
    {},
    { name: 'x' },
    { deadline },
    taskBody({ name: [] }),
    taskBody({ deadline: null }),
    taskBody({ deadline: 'bad' }),
    taskBody({ deadline: true }),
    taskBody({ completed: 'false' }),
    taskBody({ description: 3 }),
    taskBody({ assignedUser: null }),
    taskBody({ assignedUser: 'bad' }),
    taskBody({ assignedUserName: 7 }),
  ]) {
    await request('/api/tasks', 'POST', body, 400);
  }
  assert.equal(await User.countDocuments(), 0);
  assert.equal(await Task.countDocuments(), 0);
});
test('duplicate emails are rejected for POST and PUT', async () => {
  const a = await user();
  const b = await user({ name: 'Bob', email: 'bob@example.com' });
  await request('/api/users', 'POST', userBody(), 400);
  await request(`/api/users/${b._id}`, 'PUT', userBody(), 400);
  await request(`/api/users/${a._id}`, 'PUT', userBody());
  assert.equal((await request(`/api/users/${b._id}`)).email, 'bob@example.com');
});
test('URL ids take precedence over invalid fields; missing references use 404', async () => {
  for (const resource of ['users', 'tasks']) {
    for (const id of ['bad', absent]) {
      await request(`/api/${resource}/${id}`, 'GET', undefined, 404);
      await request(`/api/${resource}/${id}`, 'PUT', {}, 404);
      await request(`/api/${resource}/${id}`, 'DELETE', undefined, 404);
    }
  }
  await request('/api/tasks', 'POST', taskBody({ assignedUser: absent }), 404);
  await request('/api/users', 'POST', userBody({ pendingTasks: [absent] }), 404);
  await request('/api/tasks', 'POST', taskBody({ name: 2, assignedUser: absent }), 400);
  assert.equal(await User.countDocuments(), 0);
  assert.equal(await Task.countDocuments(), 0);
});
test('POST task assignment and completion transitions keep both references consistent', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id });
  assert.equal(t.assignedUserName, a.name);
  await consistent();
  const done = await request(
    `/api/tasks/${t._id}`,
    'PUT',
    taskBody({ assignedUser: a._id, completed: true })
  );
  assert.equal(done.assignedUser, a._id);
  assert.deepEqual((await request(`/api/users/${a._id}`)).pendingTasks, []);
  await consistent();
  const reopened = await request(
    `/api/tasks/${t._id}`,
    'PUT',
    taskBody({ assignedUser: a._id })
  );
  assert.equal(reopened.completed, false);
  assert.equal(reopened.dateCreated, t.dateCreated);
  await consistent();
});
test('task transfer, completed transfer, mismatch rejection, and unassignment', async () => {
  const a = await user();
  const b = await user({ name: 'Bob', email: 'bob@example.com' });
  const t = await task({ assignedUser: a._id });
  await request(
    `/api/tasks/${t._id}`,
    'PUT',
    taskBody({ assignedUser: b._id, assignedUserName: 'Alice' }),
    400
  );
  assert.equal((await request(`/api/tasks/${t._id}`)).assignedUser, a._id);
  await request(`/api/tasks/${t._id}`, 'PUT', taskBody({ assignedUser: b._id }));
  await consistent();
  await request(
    `/api/tasks/${t._id}`,
    'PUT',
    taskBody({ assignedUser: a._id, completed: true })
  );
  await consistent();
  assert.deepEqual((await request(`/api/users/${a._id}`)).pendingTasks, []);
  await request(`/api/tasks/${t._id}`, 'PUT', taskBody({ assignedUser: '' }));
  await consistent();
  await request('/api/tasks', 'POST', taskBody({ assignedUserName: 'Someone' }), 400);
});
test('user PUT moves pending tasks, drops removed ones, and renames completed tasks', async () => {
  const a = await user();
  const b = await user({ name: 'Bob', email: 'bob@example.com' });
  const old = await task({ assignedUser: a._id });
  const moved = await task({ assignedUser: b._id });
  const done = await task({ assignedUser: a._id, completed: true });
  const updated = await request(
    `/api/users/${a._id}`,
    'PUT',
    userBody({ name: 'New Alice', pendingTasks: [moved._id, moved._id] })
  );
  assert.equal(updated.dateCreated, a.dateCreated);
  assert.deepEqual(updated.pendingTasks, [moved._id]);
  assert.equal((await request(`/api/tasks/${old._id}`)).assignedUser, '');
  assert.equal((await request(`/api/tasks/${done._id}`)).assignedUserName, 'New Alice');
  await consistent();
  await request(`/api/users/${a._id}`, 'PUT', userBody());
  assert.equal((await request(`/api/tasks/${moved._id}`)).assignedUser, '');
  await consistent();
});
test('POST user can claim pending tasks and removes them from an old owner', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id });
  const b = await user({ name: 'Bob', email: 'bob@example.com', pendingTasks: [t._id] });
  assert.equal((await request(`/api/tasks/${t._id}`)).assignedUser, b._id);
  await consistent();
});
test('invalid pending tasks and duplicate email leave all references unchanged', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id });
  const done = await task({ completed: true });
  const snapshot = JSON.stringify(await Task.find().sort({ _id: 1 }).lean());
  await request(
    '/api/users',
    'POST',
    userBody({ name: 'Bob', email: 'bob@example.com', pendingTasks: [t._id, done._id] }),
    400
  );
  await request(
    `/api/users/${a._id}`,
    'PUT',
    userBody({ name: 'Changed', pendingTasks: [t._id, absent] }),
    404
  );
  assert.equal(JSON.stringify(await Task.find().sort({ _id: 1 }).lean()), snapshot);
  await consistent();
});
test('PUT replaces omitted fields and ignores client dateCreated', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id, description: 'old', completed: true });
  const next = await request(
    `/api/tasks/${t._id}`,
    'PUT',
    taskBody({ dateCreated: '2000-01-01' })
  );
  assert.equal(next.description, '');
  assert.equal(next.completed, false);
  assert.equal(next.assignedUser, '');
  assert.equal(next.dateCreated, t.dateCreated);
  await consistent();
});
test('single-resource select works and other query parameters are ignored', async () => {
  const a = await user();
  const t = await task();
  for (const [path, id] of [
    ['users', a._id],
    ['tasks', t._id],
  ]) {
    const value = await request(
      `/api/${path}/${id}?${query({ select: { name: 1, _id: 0 } })}&where=not-json&count=bad`
    );
    assert.deepEqual(Object.keys(value), ['name']);
    await request(`/api/${path}/${id}?select=broken`, 'GET', undefined, 400);
  }
});
test('combined where/sort/select/skip/limit and count use database queries', async () => {
  for (let i = 0; i < 6; i++) await task({ name: `Task ${i}`, completed: i % 2 === 0 });
  const result = await request(
    '/api/tasks?' +
      query({
        where: { completed: true },
        sort: { name: -1 },
        select: { name: 1, _id: 0 },
        skip: 1,
        limit: 1,
      })
  );
  assert.deepEqual(result, [{ name: 'Task 2' }]);
  assert.equal(
    await request('/api/tasks?' + query({ where: { completed: true }, count: true })),
    3
  );
  assert.deepEqual(
    await request('/api/tasks?' + query({ where: { _id: { $in: [absent] } } })),
    []
  );
  assert.equal(await request('/api/users?' + query({ count: true })), 0);
});
test('task default limit is 100, users are unlimited, explicit limit=0 is unlimited', async () => {
  await Task.insertMany(
    Array.from({ length: 105 }, (_, i) => taskBody({ name: `t${i}` }))
  );
  await User.insertMany(
    Array.from({ length: 105 }, (_, i) => userBody({ email: `u${i}@example.com` }))
  );
  assert.equal((await request('/api/tasks')).length, 100);
  assert.equal((await request('/api/tasks?limit=0')).length, 105);
  assert.equal((await request('/api/users')).length, 105);
});
test('query type/JSON errors and mixed projection are 400, not leaked internals', async () => {
  for (const suffix of [
    'where=bad',
    'where=null',
    'where=[]',
    'sort=[]',
    'sort={"name":0}',
    'select={"name":1,"email":0}',
    'select={"name":"$email"}',
    'skip=-1',
    'skip=1.2',
    'limit="2"',
    'limit=null',
    'count=1',
    'count=undefined',
    'where={"$where":"true"}',
    'where={"name":{"$invalid":2}}',
    'where={"_id":"bad"}',
  ]) {
    await request('/api/tasks?' + encodeURI(suffix), 'GET', undefined, 400);
  }
});
test('form-encoded requests work, including completed booleans and pendingTasks JSON', async () => {
  const t = await task();
  const a = await request(
    '/api/users',
    'POST',
    new URLSearchParams({
      name: 'Alice',
      email: 'alice@example.com',
      pendingTasks: JSON.stringify([t._id]),
    }).toString(),
    201,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  await request(
    `/api/tasks/${t._id}`,
    'PUT',
    new URLSearchParams({
      name: 'Done',
      deadline,
      completed: 'true',
      assignedUser: a._id,
    }).toString(),
    200,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  await consistent();
});
test('deletion cascades to pending and completed tasks and repeated delete is 404', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id });
  const done = await task({ assignedUser: a._id, completed: true });
  await request(`/api/tasks/${t._id}`, 'DELETE');
  await consistent();
  await request(`/api/tasks/${t._id}`, 'GET', undefined, 404);
  await request(`/api/tasks/${t._id}`, 'DELETE', undefined, 404);
  await request(`/api/users/${a._id}`, 'DELETE');
  assert.equal((await request(`/api/tasks/${done._id}`)).assignedUser, '');
  await consistent();
  await request(`/api/users/${a._id}`, 'GET', undefined, 404);
});
test('a database error after a write rolls the whole transaction back', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id });
  const original = Task.updateMany;
  Task.updateMany = () => {
    throw new Error('private database internals');
  };
  try {
    const response = await fetch(base + `/api/users/${a._id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(userBody({ name: 'Changed' })),
    });
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('private database internals'));
  } finally {
    Task.updateMany = original;
  }
  assert.equal((await request(`/api/users/${a._id}`)).name, 'Alice');
  assert.equal((await request(`/api/tasks/${t._id}`)).assignedUser, a._id);
  await consistent();
});
test('concurrent transfers and duplicate-email creation remain consistent', async () => {
  const a = await user();
  const b = await user({ name: 'Bob', email: 'bob@example.com' });
  const t = await task();
  await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      request(
        `/api/tasks/${t._id}`,
        'PUT',
        taskBody({ assignedUser: i % 2 ? a._id : b._id })
      )
    )
  );
  await consistent();
  const responses = await Promise.all(
    [1, 2].map(() =>
      fetch(base + '/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(userBody({ email: 'same@example.com' })),
      })
    )
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 400]);
  assert.equal(await User.countDocuments({ email: 'same@example.com' }), 1);
});
test('unknown routes and malformed request JSON return the API error envelope', async () => {
  await request('/unknown', 'GET', undefined, 404);
  await request('/api/users', 'POST', '{bad', 400);
});

test('invalid query operators for a field are client errors, not server failures', async () => {
  for (const where of [{ name: { $size: -1 } }, { deadline: { $not: 4 } }]) {
    await request('/api/tasks?' + query({ where }), 'GET', undefined, 400);
  }
});
test('projection rejects colliding or malformed field paths', async () => {
  const a = await user();
  const t = await task();
  for (const select of [
    { name: 1, 'name.child': 1 },
    { 'name.': 1 },
    { 'name..child': 1 },
  ]) {
    for (const path of [
      '/api/users',
      '/api/tasks',
      `/api/users/${a._id}`,
      `/api/tasks/${t._id}`,
    ]) {
      await request(path + '?' + query({ select }), 'GET', undefined, 400);
    }
  }
});
test('standard JSON expression and logical filters are supported', async () => {
  await task({ name: 'Alpha' });
  await task({ name: 'Beta', completed: true });
  await task({ name: 'Gamma' });
  const result = await request(
    '/api/tasks?' + query({ where: { $expr: { $eq: ['$completed', true] } } })
  );
  assert.deepEqual(
    result.map((t) => t.name),
    ['Beta']
  );
  const logical = await request(
    '/api/tasks?' +
      query({
        where: { $or: [{ name: { $regex: '^A' } }, { completed: true }] },
        sort: { name: 1 },
        select: { name: 1, _id: 0 },
      })
  );
  assert.deepEqual(logical, [{ name: 'Alpha' }, { name: 'Beta' }]);
});

test('all 64 query parameter combinations work on both users and tasks (128 requests)', async () => {
  const fixtures = { users: [], tasks: [] };
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
    fixtures.users.push(await user({ name, email: `${name}@example.com` }));
    fixtures.tasks.push(await task({ name }));
  }
  const choices = {
    where: { name: { $in: ['Alpha', 'Gamma', 'Epsilon'] } },
    sort: { name: -1 },
    select: { name: 1, _id: 0 },
    skip: 1,
    limit: 2,
    count: true,
  };
  const keys = Object.keys(choices);
  for (const resource of ['users', 'tasks']) {
    for (let mask = 0; mask < 64; mask++) {
      const params = Object.fromEntries(
        keys.filter((_, index) => mask & (1 << index)).map((key) => [key, choices[key]])
      );
      let expected = fixtures[resource].filter(
        (doc) => !params.where || ['Alpha', 'Gamma', 'Epsilon'].includes(doc.name)
      );
      const matchCount = expected.length;
      if (params.sort)
        expected = [...expected].sort((a, b) => b.name.localeCompare(a.name));
      if (params.skip) expected = expected.slice(1);
      if (params.limit) expected = expected.slice(0, 2);
      if (params.select) expected = expected.map(({ name }) => ({ name }));
      const actual = await request(`/api/${resource}?${query(params)}`);
      assert.deepEqual(
        actual,
        params.count ? matchCount : expected,
        `${resource}, combination ${mask}`
      );
    }
  }
});
test('collection users support projections, empty matches, count and repeated-parameter rejection', async () => {
  await user();
  assert.deepEqual(await request('/api/users?' + query({ where: { _id: absent } })), []);
  assert.equal(
    await request('/api/users?' + query({ where: { _id: absent }, count: true })),
    0
  );
  const excluded = await request('/api/users?' + query({ select: { _id: 0, email: 0 } }));
  assert.equal(excluded[0]._id, undefined);
  assert.equal(excluded[0].email, undefined);
  assert.equal(excluded[0].name, 'Alice');
  for (const resource of ['users', 'tasks']) {
    await request(`/api/${resource}?limit=1&limit=2`, 'GET', undefined, 400);
    await request(`/api/${resource}?where={}&where={}`, 'GET', undefined, 400);
  }
});
test('PUT rejects invalid fields and reference values without altering existing documents', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id });
  const done = await task({ completed: true });
  const snapshot = async () =>
    JSON.stringify({
      users: await User.find().sort({ _id: 1 }).lean(),
      tasks: await Task.find().sort({ _id: 1 }).lean(),
    });
  const initial = await snapshot();
  for (const body of [
    {},
    userBody({ email: [] }),
    userBody({ pendingTasks: null }),
    userBody({ pendingTasks: ['bad'] }),
    userBody({ pendingTasks: [done._id] }),
  ]) {
    await request(`/api/users/${a._id}`, 'PUT', body, 400);
    assert.equal(await snapshot(), initial);
  }
  for (const body of [
    {},
    taskBody({ deadline: {} }),
    taskBody({ completed: 0 }),
    taskBody({ assignedUser: 'bad' }),
    taskBody({ assignedUser: a._id, assignedUserName: 'wrong' }),
  ]) {
    await request(`/api/tasks/${t._id}`, 'PUT', body, 400);
    assert.equal(await snapshot(), initial);
  }
  await request(`/api/tasks/${t._id}`, 'PUT', taskBody({ assignedUser: absent }), 404);
  await request(`/api/users/${a._id}`, 'PUT', userBody({ pendingTasks: [absent] }), 404);
  assert.equal(await snapshot(), initial);
  await consistent();
});
test('uppercase ObjectIds are canonicalized in URL ids, owner ids and pendingTasks', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id.toUpperCase() });
  assert.equal(t.assignedUser, a._id);
  await request(
    `/api/users/${a._id.toUpperCase()}`,
    'PUT',
    userBody({ pendingTasks: [t._id.toUpperCase(), t._id] })
  );
  const actual = await request(`/api/tasks/${t._id.toUpperCase()}`);
  assert.equal(actual._id, t._id);
  await consistent();
});
test('POST with a completed assigned task preserves owner without creating a pending reference', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id, completed: true });
  assert.equal(t.assignedUserName, a.name);
  assert.deepEqual((await request(`/api/users/${a._id}`)).pendingTasks, []);
  await consistent();
});
test('POST, PUT and DELETE all roll back partial writes after database failures', async () => {
  const a = await user();
  const t = await task({ assignedUser: a._id });
  await task({ assignedUser: a._id, completed: true });
  const snapshot = async () =>
    JSON.stringify({
      users: await User.find().sort({ _id: 1 }).lean(),
      tasks: await Task.find().sort({ _id: 1 }).lean(),
    });
  const originalState = await snapshot();
  const cases = [
    {
      target: Task,
      key: 'updateMany',
      path: '/api/users',
      method: 'POST',
      body: userBody({ email: 'new@example.com', pendingTasks: [t._id] }),
    },
    {
      target: User,
      key: 'updateMany',
      path: '/api/tasks',
      method: 'POST',
      body: taskBody({ assignedUser: a._id }),
    },
    {
      target: User,
      key: 'updateMany',
      path: `/api/tasks/${t._id}`,
      method: 'PUT',
      body: taskBody({ name: 'Changed', assignedUser: a._id }),
    },
    {
      target: User.prototype,
      key: 'deleteOne',
      path: `/api/users/${a._id}`,
      method: 'DELETE',
    },
    {
      target: Task.prototype,
      key: 'deleteOne',
      path: `/api/tasks/${t._id}`,
      method: 'DELETE',
    },
  ];
  for (const item of cases) {
    const previous = item.target[item.key];
    item.target[item.key] = () => {
      throw new Error('Intentional rollback verification');
    };
    try {
      await request(item.path, item.method, item.body, 500);
    } finally {
      item.target[item.key] = previous;
    }
    assert.equal(
      await snapshot(),
      originalState,
      `${item.method} ${item.path} changed the database after failure`
    );
    await consistent();
  }
});
test('concurrent user and task transfers preserve the same ownership invariant', async () => {
  const a = await user();
  const b = await user({ name: 'Bob', email: 'bob@example.com' });
  const t = await task();
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      i % 2
        ? request(`/api/users/${a._id}`, 'PUT', userBody({ pendingTasks: [t._id] }))
        : request(`/api/tasks/${t._id}`, 'PUT', taskBody({ assignedUser: b._id }))
    )
  );
  await consistent();
});
test('a database read failure remains a generic 500 rather than a query-validation 400', async () => {
  const previous = Task.Query.prototype.exec;
  Task.Query.prototype.exec = async () => {
    throw new Error('private connection details');
  };
  try {
    const response = await fetch(base + '/api/tasks');
    assert.equal(response.status, 500);
    const value = await response.json();
    assert.equal(value.data, null);
    assert.ok(!value.message.includes('private connection details'));
  } finally {
    Task.Query.prototype.exec = previous;
  }
});

test('combined validation errors follow the README URL, field-value, reference precedence', async () => {
  const a = await user();
  const b = await user({ name: 'Bob', email: 'bob@example.com' });
  const done = await task({ completed: true });
  await request(`/api/users/${absent}`, 'PUT', userBody({ pendingTasks: ['bad'] }), 404);
  await request(
    `/api/users/${a._id}`,
    'PUT',
    userBody({ pendingTasks: [done._id, absent] }),
    400
  );
  await request(
    `/api/users/${b._id}`,
    'PUT',
    userBody({ email: a.email, pendingTasks: [absent] }),
    400
  );
  assert.equal((await request(`/api/users/${a._id}`)).name, a.name);
  assert.equal((await request(`/api/users/${b._id}`)).email, b.email);
  await consistent();
});
