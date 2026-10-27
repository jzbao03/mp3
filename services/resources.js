const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { ApiError } = require('../lib/errors');
const { validId, userFields, taskFields } = require('../lib/validation');
async function existing(Model, id, session) {
  if (!validId(id)) throw new ApiError(404, `${Model.modelName} not found.`);
  const doc = await Model.findById(id).session(session);
  if (!doc) throw new ApiError(404, `${Model.modelName} not found.`);
  return doc;
}
async function writeUser(id, body, form, session) {
  // URL resource existence takes precedence over body validation.
  const previous = id ? await existing(User, id, session) : null;
  const fields = userFields(body, form);
  const duplicate = await User.findOne({ email: fields.email,
    ...(previous ? { _id: { $ne: previous._id } } : {}) }).session(session);
  if (duplicate) throw new ApiError(400, 'This email address is already in use.');
  const tasks = await Task.find({ _id: { $in: fields.pendingTasks } }).session(session);
  if (tasks.some((task) => task.completed)) throw new ApiError(400, 'pendingTasks may only contain tasks that are not completed.');
  if (tasks.length !== fields.pendingTasks.length) throw new ApiError(404, 'A pending task was not found.');
  const user = previous || new User();
  const userId = user._id.toString();
  user.set(fields);
  await user.save({ session });
  // Completed tasks keep their owner when pendingTasks is replaced.
  await Task.updateMany({ assignedUser: userId, completed: false, _id: { $nin: fields.pendingTasks } },
    { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
  await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: fields.pendingTasks } },
    { $pull: { pendingTasks: { $in: fields.pendingTasks } } }, { session });
  await Task.updateMany({ _id: { $in: fields.pendingTasks } },
    { $set: { assignedUser: userId, assignedUserName: user.name } }, { session });
  // Renames propagate to completed tasks too.
  await Task.updateMany({ assignedUser: userId }, { $set: { assignedUserName: user.name } }, { session });
  return user.toObject();
}
async function writeTask(id, body, form, session) {
  const previous = id ? await existing(Task, id, session) : null;
  const fields = taskFields(body, form);
  let owner;
  if (fields.assignedUser) {
    owner = await User.findById(fields.assignedUser).session(session);
    if (!owner) throw new ApiError(404, 'The assigned user was not found.');
    if (fields.assignedUserName !== undefined && fields.assignedUserName !== owner.name) {
      throw new ApiError(400, 'assignedUserName must match the assigned user.');
    }
  }
  fields.assignedUserName = owner ? owner.name : 'unassigned';
  const task = previous || new Task();
  task.set(fields);
  await task.save({ session });
  const taskId = task._id.toString();
  await User.updateMany({ pendingTasks: taskId }, { $pull: { pendingTasks: taskId } }, { session });
  if (owner && !task.completed) {
    await User.updateOne({ _id: owner._id }, { $addToSet: { pendingTasks: taskId } }, { session });
  }
  return task.toObject();
}
async function remove(Model, id, session) {
  const doc = await existing(Model, id, session);
  const resourceId = doc._id.toString();
  if (Model === User) {
    await Task.updateMany({ assignedUser: resourceId },
      { $set: { assignedUser: '', assignedUserName: 'unassigned' } }, { session });
  } else {
    await User.updateMany({ pendingTasks: resourceId }, { $pull: { pendingTasks: resourceId } }, { session });
  }
  await doc.deleteOne({ session });
  return doc.toObject();
}
function transaction(operation) {
  // This callback can be retried; send HTTP responses only after it commits.
  return mongoose.connection.transaction(operation);
}
module.exports = { writeUser, writeTask, remove, transaction };
