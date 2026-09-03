const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
  initSentry,
  captureException,
  captureMessage,
  sanitizeSentryEvent,
  sanitizeSentryValue,
  isSentryActive,
  _resetForTesting
} = require('../src/utils/sentry');

describe('Sentry Integration & Sanitization Hardening', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  test('initSentry safely no-ops when SENTRY_DSN is not configured', () => {
    const origDsn = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;

    try {
      const active = initSentry();
      assert.strictEqual(active, false);
      assert.strictEqual(isSentryActive(), false);
    } finally {
      if (origDsn) process.env.SENTRY_DSN = origDsn;
    }
  });

  test('initSentry activates cleanly when SENTRY_DSN is provided', () => {
    const origDsn = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = 'https://mock_public_key@o0.ingest.sentry.io/0000000';

    try {
      const active = initSentry();
      assert.strictEqual(active, true);
      assert.strictEqual(isSentryActive(), true);
    } finally {
      if (origDsn) {
        process.env.SENTRY_DSN = origDsn;
      } else {
        delete process.env.SENTRY_DSN;
      }
      _resetForTesting();
    }
  });

  test('sanitizeSentryEvent scrubs secrets and auth headers', () => {
    const rawEvent = {
      request: {
        headers: {
          'authorization': 'Bearer super_secret_access_token_123',
          'x-api-key': 'secret_dashboard_key_456',
          'x-hub-signature-256': 'sha256=1234567890abcdef',
          'cookie': 'session_id=abcdef123456',
          'content-type': 'application/json'
        },
        data: {
          token: 'jwt_secret_token',
          secret_key: 'openrouter_key_abc',
          metaAppSecret: 'meta_secret_xyz',
          safe_field: 'safe_value'
        }
      }
    };

    const sanitized = sanitizeSentryEvent(rawEvent);

    assert.strictEqual(sanitized.request.headers['authorization'], '[REDACTED]');
    assert.strictEqual(sanitized.request.headers['x-api-key'], '[REDACTED]');
    assert.strictEqual(sanitized.request.headers['x-hub-signature-256'], '[REDACTED]');
    assert.strictEqual(sanitized.request.headers['cookie'], '[REDACTED]');
    assert.strictEqual(sanitized.request.headers['content-type'], 'application/json');

    assert.strictEqual(sanitized.request.data.token, '[REDACTED SECRET]');
    assert.strictEqual(sanitized.request.data.secret_key, '[REDACTED SECRET]');
    assert.strictEqual(sanitized.request.data.metaAppSecret, '[REDACTED SECRET]');
    assert.strictEqual(sanitized.request.data.safe_field, 'safe_value');
  });

  test('sanitizeSentryEvent scrubs raw customer WhatsApp message text and masks phone numbers', () => {
    const rawEvent = {
      extra: {
        wa_id: '919876543210',
        recipient_id: '919123456789',
        incomingText: 'Hey, I want to discuss membership pricing for Goldkraft',
        replyText: 'Our memberships start at 4040/month',
        body: 'Can I get personal training?',
        message: 'Raw text of customer message',
        tenantId: 'tenant_omega'
      }
    };

    const sanitized = sanitizeSentryEvent(rawEvent);

    // Verify phone numbers are masked
    assert.strictEqual(sanitized.extra.wa_id, '91*****3210');
    assert.strictEqual(sanitized.extra.recipient_id, '91*****6789');

    // Verify message content is redacted
    assert.strictEqual(sanitized.extra.incomingText, '[REDACTED MESSAGE CONTENT]');
    assert.strictEqual(sanitized.extra.replyText, '[REDACTED MESSAGE CONTENT]');
    assert.strictEqual(sanitized.extra.body, '[REDACTED MESSAGE CONTENT]');
    assert.strictEqual(sanitized.extra.message, '[REDACTED MESSAGE CONTENT]');

    // Verify tenant ID is preserved safely
    assert.strictEqual(sanitized.extra.tenantId, 'tenant_omega');
  });

  test('captureException and captureMessage do not throw even when Sentry is inactive', () => {
    assert.doesNotThrow(() => {
      captureException(new Error('Simulated test error'), {
        component: 'unit_test',
        wa_id: '919999999999',
        text: 'secret text'
      });
    });

    assert.doesNotThrow(() => {
      captureMessage('Simulated warning message', 'warn', {
        component: 'unit_test',
        tenantId: 'tenant_omega'
      });
    });
  });
});
