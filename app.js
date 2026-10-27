const express = require('express');
const mongoose = require('mongoose');
const routes = require('./routes');
const { ApiError } = require('./lib/errors');
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
app.get('/health', (req, res) => {
  const ready = mongoose.connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ message: ready ? 'OK' : 'Database unavailable.', data: { ready } });
});
app.get('/', (req, res) => res.json({ message: 'CS409 MP3 task management API.', data: { api: '/api', health: '/health' } }));
app.use('/api', routes);
app.use((req, res) => res.status(404).json({ message: 'Endpoint not found.', data: null }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  let status = 500;
  let message = 'The request could not be completed. Please try again.';
  if (error instanceof ApiError) { status = error.status; message = error.message; }
  else if (error.code === 11000) { status = 400; message = 'This email address is already in use.'; }
  else if (['ValidationError', 'CastError', 'StrictModeError'].includes(error.name)) {
    status = 400; message = 'A field contains an invalid value.';
  } else if (error.type === 'entity.parse.failed') { status = 400; message = 'The request body contains invalid JSON.'; }
  else if (error.type === 'entity.too.large') { status = 400; message = 'The request body is too large.'; }
  else if ([2, 9, 14, 72, 168, 17287, 31253, 31254, 51091].includes(error.code)) {
    status = 400; message = 'The query contains invalid options or values.';
  }
  if (status === 500) console.error('Request failed:', error.name, error.code || '');
  res.status(status).json({ message, data: null });
});
module.exports = app;
