const express = require('express');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('../lib/errors');
const { validId } = require('../lib/validation');
const { collectionOptions, projection, castFilter } = require('../lib/query');
const { writeUser, writeTask, remove, transaction } = require('../services/resources');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    message: 'Task management API is ready.',
    data: { users: '/api/users', tasks: '/api/tasks' },
  });
});

function addResourceRoutes(path, Model, writeResource) {
  const collectionPath = `/${path}`;
  const resourcePath = `${collectionPath}/:id`;

  router.get(collectionPath, async (req, res) => {
    const options = collectionOptions(req.query, Model === Task);
    let query;

    if (options.count) {
      query = Model.countDocuments(options.where);
    } else {
      query = Model.find(options.where)
        .sort(options.sort)
        .select(options.select)
        .skip(options.skip)
        .limit(options.limit)
        .lean();
    }

    const data = await castFilter(query, Model).maxTimeMS(10000);
    res.json({ message: 'OK', data });
  });

  router.get(resourcePath, async (req, res) => {
    if (!validId(req.params.id)) {
      throw new ApiError(404, `${Model.modelName} not found.`);
    }

    // Collection filters do not apply when the URL already identifies one resource.
    const data = await Model.findById(req.params.id).select(projection(req.query)).lean();

    if (!data) {
      throw new ApiError(404, `${Model.modelName} not found.`);
    }

    res.json({ message: 'OK', data });
  });

  router.post(collectionPath, async (req, res) => {
    const isForm = Boolean(req.is('application/x-www-form-urlencoded'));
    const data = await transaction((session) => {
      return writeResource(null, req.body, isForm, session);
    });

    res.status(201).json({ message: `${Model.modelName} created.`, data });
  });

  router.put(resourcePath, async (req, res) => {
    const isForm = Boolean(req.is('application/x-www-form-urlencoded'));
    const data = await transaction((session) => {
      return writeResource(req.params.id, req.body, isForm, session);
    });

    res.json({ message: `${Model.modelName} updated.`, data });
  });

  router.delete(resourcePath, async (req, res) => {
    await transaction((session) => remove(Model, req.params.id, session));
    res.status(204).end();
  });
}

addResourceRoutes('users', User, writeUser);
addResourceRoutes('tasks', Task, writeTask);

module.exports = router;
