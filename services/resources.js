const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('../lib/errors');
const { validId, userFields, taskFields } = require('../lib/validation');

async function findResource(Model, id, session) {
  if (!validId(id)) {
    throw new ApiError(404, `${Model.modelName} not found.`);
  }

  const resource = await Model.findById(id).session(session);
  if (!resource) {
    throw new ApiError(404, `${Model.modelName} not found.`);
  }
  return resource;
}

async function syncUserTasks(user, pendingTaskIds, session) {
  const userId = user._id.toString();

  // A replaced pending list releases removed tasks, but keeps completed tasks assigned.
  await Task.updateMany(
    { assignedUser: userId, completed: false, _id: { $nin: pendingTaskIds } },
    { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
    { session }
  );

  // Claiming another user's task also removes it from that user's pending list.
  await User.updateMany(
    { _id: { $ne: user._id }, pendingTasks: { $in: pendingTaskIds } },
    { $pull: { pendingTasks: { $in: pendingTaskIds } } },
    { session }
  );
  await Task.updateMany(
    { _id: { $in: pendingTaskIds } },
    { $set: { assignedUser: userId, assignedUserName: user.name } },
    { session }
  );

  // Completed tasks still belong to the user, so their names must follow a rename too.
  await Task.updateMany(
    { assignedUser: userId },
    { $set: { assignedUserName: user.name } },
    { session }
  );
}

async function writeUser(id, body, isForm, session) {
  // Check the URL first: a missing user takes precedence over an invalid body.
  const existingUser = id ? await findResource(User, id, session) : null;
  const userData = userFields(body, isForm);

  const emailFilter = { email: userData.email };
  if (existingUser) {
    emailFilter._id = { $ne: existingUser._id };
  }
  const emailOwner = await User.findOne(emailFilter).session(session);
  if (emailOwner) {
    throw new ApiError(400, 'This email address is already in use.');
  }

  const pendingTasks = await Task.find({ _id: { $in: userData.pendingTasks } }).session(
    session
  );
  if (pendingTasks.some((task) => task.completed)) {
    throw new ApiError(
      400,
      'pendingTasks may only contain tasks that are not completed.'
    );
  }
  if (pendingTasks.length !== userData.pendingTasks.length) {
    throw new ApiError(404, 'A pending task was not found.');
  }

  const user = existingUser || new User();
  user.set(userData);
  await user.save({ session });
  await syncUserTasks(user, userData.pendingTasks, session);

  return user.toObject();
}

async function writeTask(id, body, isForm, session) {
  const existingTask = id ? await findResource(Task, id, session) : null;
  const taskData = taskFields(body, isForm);
  let owner;

  if (taskData.assignedUser) {
    owner = await User.findById(taskData.assignedUser).session(session);
    if (!owner) {
      throw new ApiError(404, 'The assigned user was not found.');
    }
    if (
      taskData.assignedUserName !== undefined &&
      taskData.assignedUserName !== owner.name
    ) {
      throw new ApiError(400, 'assignedUserName must match the assigned user.');
    }
  }

  taskData.assignedUserName = owner ? owner.name : 'unassigned';
  const task = existingTask || new Task();
  task.set(taskData);
  await task.save({ session });

  const taskId = task._id.toString();
  await User.updateMany(
    { pendingTasks: taskId },
    { $pull: { pendingTasks: taskId } },
    { session }
  );

  // Completed tasks retain their owner without appearing in pendingTasks.
  if (owner && !task.completed) {
    await User.updateOne(
      { _id: owner._id },
      { $addToSet: { pendingTasks: taskId } },
      { session }
    );
  }

  return task.toObject();
}

async function remove(Model, id, session) {
  const resource = await findResource(Model, id, session);
  const resourceId = resource._id.toString();

  if (Model === User) {
    await Task.updateMany(
      { assignedUser: resourceId },
      { $set: { assignedUser: '', assignedUserName: 'unassigned' } },
      { session }
    );
  } else {
    await User.updateMany(
      { pendingTasks: resourceId },
      { $pull: { pendingTasks: resourceId } },
      { session }
    );
  }

  await resource.deleteOne({ session });
  return resource.toObject();
}

function transaction(operation) {
  // The driver can retry this callback. Only respond to HTTP after it commits.
  return mongoose.connection.transaction(operation);
}

module.exports = { writeUser, writeTask, remove, transaction };
