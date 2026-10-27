const express = require('express');
const mongoose = require('mongoose');
const routes = require('./routes');
const { errorHandler } = require('./lib/errors');

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set(
    'Access-Control-Allow-Headers',
    'X-Requested-With, X-HTTP-Method-Override, Content-Type, Accept'
  );
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));

app.get('/health', (req, res) => {
  const ready = mongoose.connection.readyState === 1;

  res.status(ready ? 200 : 503).json({
    message: ready ? 'OK' : 'Database unavailable.',
    data: { ready },
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'CS409 MP3 task management API.',
    data: { api: '/api', health: '/health' },
  });
});

app.use('/api', routes);
app.use((req, res) => {
  res.status(404).json({ message: 'Endpoint not found.', data: null });
});
app.use(errorHandler);

module.exports = app;
