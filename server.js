require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const app = require('./app');
const User = require('./models/user');
const Task = require('./models/task');
async function start() {
  if (!process.env.MONGODB_URI) throw new Error('Set MONGODB_URI in .env or the hosting environment.');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  await User.init();
  await Task.init();
  const server = app.listen(process.env.PORT || 3000, '0.0.0.0', () => {
    console.log(`API listening on port ${server.address().port}`);
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000).unref();
    server.close(async () => {
      await mongoose.disconnect();
      clearTimeout(timeout);
      process.exit(0);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}
if (require.main === module) start().catch((error) => {
  // Driver messages can include credentials. Do not print them.
  console.error(process.env.MONGODB_URI ? 'Startup failed. Check database connectivity and credentials.' : error.message);
  process.exit(1);
});
module.exports = { start };
