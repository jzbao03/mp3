class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The driver uses numeric codes for invalid query options and expressions.
const invalidQueryCodes = new Set([2, 9, 14, 72, 168, 17287, 31253, 31254, 51091]);
const validationErrors = new Set(['ValidationError', 'CastError', 'StrictModeError']);

function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  let status = 500;
  let message = 'The request could not be completed. Please try again.';

  if (error instanceof ApiError) {
    status = error.status;
    message = error.message;
  } else if (error.code === 11000) {
    status = 400;
    message = 'This email address is already in use.';
  } else if (validationErrors.has(error.name)) {
    status = 400;
    message = 'A field contains an invalid value.';
  } else if (error.type === 'entity.parse.failed') {
    status = 400;
    message = 'The request body contains invalid JSON.';
  } else if (error.type === 'entity.too.large') {
    status = 400;
    message = 'The request body is too large.';
  } else if (invalidQueryCodes.has(error.code)) {
    status = 400;
    message = 'The query contains invalid options or values.';
  }

  if (status === 500) {
    // Keep raw database errors out of responses and logs: they may contain credentials.
    console.error('Request failed:', error.name, error.code || '');
  }

  res.status(status).json({ message, data: null });
}

module.exports = { ApiError, errorHandler };
