const env = require('../config/env');
const logger = require('./logger');

let SentryLib = null;
let isInitialized = false;

try {
  SentryLib = require('@sentry/node');
} catch (e) {
  // @sentry/node not installed; graceful fallback to internal logger
}

/**
 * Initializes Sentry if SENTRY_DSN is configured.
 * Sanitizes beforeSend events to guarantee zero secret or customer PII leaks.
 */
function initSentry(app = null) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || !SentryLib) {
    if (dsn && !SentryLib) {
      logger.warn('SENTRY_DSN configured but @sentry/node is not installed. Sentry reporting disabled.');
    }
    return;
  }

  if (isInitialized) return;

  try {
    SentryLib.init({
      dsn,
      environment: env.nodeEnv || 'development',
      release: 'gkf-wa@1.0.0',
      tracesSampleRate: env.nodeEnv === 'production' ? 0.2 : 1.0,
      beforeSend(event) {
        // Scrub Authorization and API Key headers
        if (event.request?.headers) {
          if (event.request.headers['authorization']) event.request.headers['authorization'] = '[REDACTED]';
          if (event.request.headers['x-api-key']) event.request.headers['x-api-key'] = '[REDACTED]';
          if (event.request.headers['x-hub-signature-256']) event.request.headers['x-hub-signature-256'] = '[REDACTED]';
        }

        // Scrub sensitive body or query fields
        if (event.request?.data && typeof event.request.data === 'object') {
          for (const key of Object.keys(event.request.data)) {
            if (/token|secret|key|password|auth/i.test(key)) {
              event.request.data[key] = '[REDACTED]';
            }
          }
        }

        return event;
      }
    });

    isInitialized = true;
    logger.info('Sentry error and performance monitoring initialized', { environment: env.nodeEnv });
  } catch (err) {
    logger.error('Failed to initialize Sentry:', { error: err.message });
  }
}

/**
 * Captures an exception with optional metadata context
 */
function captureException(error, context = {}) {
  const sanitizedContext = logger.sanitizeMeta(context);
  logger.error('Exception captured:', { error: error.message, ...sanitizedContext });

  if (isInitialized && SentryLib) {
    SentryLib.withScope((scope) => {
      if (sanitizedContext.tenantId) scope.setTag('tenant_id', sanitizedContext.tenantId);
      if (sanitizedContext.component) scope.setTag('component', sanitizedContext.component);
      scope.setExtras(sanitizedContext);
      SentryLib.captureException(error);
    });
  }
}

/**
 * Captures a message with level and optional context
 */
function captureMessage(message, level = 'info', context = {}) {
  const sanitizedContext = logger.sanitizeMeta(context);
  logger.log(level, message, sanitizedContext);

  if (isInitialized && SentryLib) {
    SentryLib.withScope((scope) => {
      if (sanitizedContext.tenantId) scope.setTag('tenant_id', sanitizedContext.tenantId);
      scope.setExtras(sanitizedContext);
      SentryLib.captureMessage(message, level);
    });
  }
}

module.exports = {
  initSentry,
  captureException,
  captureMessage,
  isSentryActive: () => isInitialized
};
