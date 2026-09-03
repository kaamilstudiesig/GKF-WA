const SentryLib = require('@sentry/node');
const env = require('../config/env');
const logger = require('./logger');

let isInitialized = false;

/**
 * Sanitizes an operational message string before sending to Sentry:
 * - Redacts secrets, tokens, API keys, passwords, bearer tokens
 * - Masks customer telephone numbers (e.g. 91*****1234)
 * - Detects and redacts raw conversational customer messages
 * - Preserves genuine operational / system event messages
 */
function sanitizeSentryMessage(rawMsg) {
  if (typeof rawMsg !== 'string') {
    return String(rawMsg || '');
  }

  let sanitized = rawMsg;

  // 1. Redact Bearer and Auth tokens
  sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
  sanitized = sanitized.replace(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED JWT]');
  sanitized = sanitized.replace(/(?:api_?key|token|secret|password|signature)\s*[:=]\s*['"]?[^\s,'"}]+['"]?/gi, (match) => {
    const prefix = match.split(/[:=]/)[0];
    return `${prefix}: [REDACTED SECRET]`;
  });

  // 2. Mask phone numbers (10-15 digits, optionally with country code/plus)
  sanitized = sanitized.replace(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4,6}/g, (match) => {
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 10) {
      return `${digits.slice(0, 2)}*****${digits.slice(-4)}`;
    }
    return '[MASKED PHONE]';
  });

  // 3. Detect and redact raw customer conversational text passed directly as the message
  const trimmed = sanitized.trim();
  const isConversationalCustomerText =
    /^(?:hey|hello|hi|good\s+(?:morning|evening|afternoon)|can\s+i|how\s+much|i\s+want|i\s+would\s+like|what\s+is\s+the|tell\s+me\s+about|do\s+you\s+have|my\s+name\s+is|please\s+send)/i.test(trimmed) ||
    /(?:inbound|customer|user)\s*(?:text|message|body|input)\s*:\s*.+/i.test(sanitized);

  if (isConversationalCustomerText) {
    if (/(?:inbound|customer|user)\s*(?:text|message|body|input)\s*:\s*.+/i.test(sanitized)) {
      sanitized = sanitized.replace(/((?:inbound|customer|user)\s*(?:text|message|body|input)\s*:\s*)(.+)/i, '$1[REDACTED CUSTOMER MESSAGE]');
    } else {
      sanitized = '[REDACTED CUSTOMER MESSAGE]';
    }
  }

  return sanitized;
}

/**
 * Recursively sanitizes a value for Sentry reporting:
 * - Redacts secrets, tokens, API keys
 * - Redacts raw WhatsApp customer message content
 * - Masks customer telephone numbers
 */
function sanitizeSentryValue(key, value) {
  if (value === null || value === undefined) return value;

  // 1. Redact secrets
  if (typeof key === 'string' && /token|secret|api_?key|auth|password|signature|cookie/i.test(key)) {
    return '[REDACTED SECRET]';
  }

  // 2. Redact customer message content
  if (typeof key === 'string' && /^(text|body|message|incomingText|replyText|rawPayload|payload)$/i.test(key)) {
    return '[REDACTED MESSAGE CONTENT]';
  }

  // 3. Mask phone numbers
  if (typeof key === 'string' && /^(wa_id|phone|recipient_id|from|to)$/i.test(key) && typeof value === 'string') {
    const digits = value.replace(/[^0-9]/g, '');
    if (digits.length >= 10) {
      return `${digits.slice(0, 2)}*****${digits.slice(-4)}`;
    }
    return '[MASKED PHONE]';
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item, idx) => sanitizeSentryValue(String(idx), item));
    }
    const sanitizedObj = {};
    for (const [k, v] of Object.entries(value)) {
      sanitizedObj[k] = sanitizeSentryValue(k, v);
    }
    return sanitizedObj;
  }

  return value;
}

/**
 * Sanitizes Sentry event payload before transmission
 */
function sanitizeSentryEvent(event) {
  if (!event) return event;

  // Sanitize top-level message if present
  if (event.message) {
    event.message = sanitizeSentryMessage(event.message);
  }

  // Sanitize request headers
  if (event.request?.headers) {
    for (const header of Object.keys(event.request.headers)) {
      if (/authorization|x-api-key|x-hub-signature-256|cookie/i.test(header)) {
        event.request.headers[header] = '[REDACTED]';
      }
    }
  }

  // Sanitize request body / data
  if (event.request?.data && typeof event.request.data === 'object') {
    event.request.data = sanitizeSentryValue('data', event.request.data);
  }

  // Sanitize extra context
  if (event.extra && typeof event.extra === 'object') {
    event.extra = sanitizeSentryValue('extra', event.extra);
  }

  // Sanitize breadcrumbs
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map(b => {
      if (b.message) {
        b.message = sanitizeSentryMessage(b.message);
      }
      if (b.data && typeof b.data === 'object') {
        b.data = sanitizeSentryValue('breadcrumb_data', b.data);
      }
      return b;
    });
  }

  return event;
}

/**
 * Initializes Sentry if SENTRY_DSN is configured.
 * Safely no-ops in development/test or when SENTRY_DSN is unset.
 */
function initSentry() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    if (env.nodeEnv === 'production') {
      logger.info('SENTRY_DSN is not set; external crash reporting is inactive.');
    }
    return false;
  }

  if (isInitialized) return true;

  try {
    SentryLib.init({
      dsn,
      environment: env.nodeEnv || 'development',
      release: 'gkf-wa@1.0.0',
      tracesSampleRate: env.nodeEnv === 'production' ? 0.2 : 1.0,
      beforeSend: sanitizeSentryEvent
    });

    isInitialized = true;
    logger.info('Sentry crash & performance monitoring successfully initialized', {
      environment: env.nodeEnv,
      release: 'gkf-wa@1.0.0'
    });
    return true;
  } catch (err) {
    logger.error('Failed to initialize Sentry:', { error: err.message });
    return false;
  }
}

/**
 * Captures an exception with optional metadata context
 */
function captureException(error, context = {}) {
  const sanitizedContext = logger.sanitizeMeta(context);
  logger.error('Exception captured:', { error: error.message, ...sanitizedContext });

  if (isInitialized && SentryLib) {
    try {
      SentryLib.withScope((scope) => {
        if (sanitizedContext.tenantId) scope.setTag('tenant_id', sanitizedContext.tenantId);
        if (sanitizedContext.component) scope.setTag('component', sanitizedContext.component);
        scope.setExtras(sanitizedContext);
        SentryLib.captureException(error);
      });
    } catch (sentryErr) {
      logger.warn('Failed to send error to Sentry:', { error: sentryErr.message });
    }
  }
}

/**
 * Captures a message with level and optional context.
 * Guarantees that the message string is sanitized and safe before sending to Sentry.
 */
function captureMessage(message, level = 'info', context = {}) {
  const sanitizedMsg = sanitizeSentryMessage(message);
  const sanitizedContext = logger.sanitizeMeta(context);
  logger.log(level, sanitizedMsg, sanitizedContext);

  if (isInitialized && SentryLib) {
    try {
      SentryLib.withScope((scope) => {
        if (sanitizedContext.tenantId) scope.setTag('tenant_id', sanitizedContext.tenantId);
        if (sanitizedContext.component) scope.setTag('component', sanitizedContext.component);
        scope.setExtras(sanitizedContext);
        SentryLib.captureMessage(sanitizedMsg, level);
      });
    } catch (sentryErr) {
      logger.warn('Failed to send message to Sentry:', { error: sentryErr.message });
    }
  }
}

module.exports = {
  initSentry,
  captureException,
  captureMessage,
  sanitizeSentryMessage,
  sanitizeSentryEvent,
  sanitizeSentryValue,
  isSentryActive: () => isInitialized,
  _resetForTesting: () => { isInitialized = false; }
};
