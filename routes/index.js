const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('../lib/errors');
const { validId } = require('../lib/validation');
const { collectionOptions, projection } = require('../lib/query');
const { writeUser, writeTask, remove, transaction } = require('../services/resources');
const router = express.Router();
router.get('/', (req, res) => res.json({ message: 'Task management API is ready.', data: { users: '/api/users', tasks: '/api/tasks' } }));
for (const [path, Model, write] of [['users', User, writeUser], ['tasks', Task, writeTask]]) {
  router.get(`/${path}`, async (req, res) => {
    const options = collectionOptions(req.query, Model === Task);
    const query = options.count ? Model.countDocuments(options.where)
      : Model.find(options.where).sort(options.sort).select(options.select)
        .skip(options.skip).limit(options.limit).lean();
    const data = await query.maxTimeMS(10000);
    res.json({ message: 'OK', data });
  });
  router.get(`/${path}/:id`, async (req, res) => {
    if (!validId(req.params.id)) throw new ApiError(404, `${Model.modelName} not found.`);
    // Only select applies to single-resource GET requests.
    const data = await Model.findById(req.params.id).select(projection(req.query)).lean();
    if (!data) throw new ApiError(404, `${Model.modelName} not found.`);
    res.json({ message: 'OK', data });
  });
  router.post(`/${path}`, async (req, res) => {
    const data = await transaction((session) => write(null, req.body,
      Boolean(req.is('application/x-www-form-urlencoded')), session));
    res.status(201).json({ message: `${Model.modelName} created.`, data });
  });
  router.put(`/${path}/:id`, async (req, res) => {
    const data = await transaction((session) => write(req.params.id, req.body,
      Boolean(req.is('application/x-www-form-urlencoded')), session));
    res.json({ message: `${Model.modelName} updated.`, data });
  });
  router.delete(`/${path}/:id`, async (req, res) => {
    const data = await transaction((session) => remove(Model, req.params.id, session));
    res.json({ message: `${Model.modelName} deleted.`, data });
  });
}
module.exports = router;
