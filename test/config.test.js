const { test, describe } = require('node:test');
const assert = require('node:assert');
const env = require('../src/config/env');

describe('Production Environment Validation', () => {
  test('throws critical error when NODE_ENV=production and required env vars are missing', () => {
    const originalNodeEnv = env.nodeEnv;
    const originalSecret = env.metaAppSecret;

    env.nodeEnv = 'production';
    env.metaAppSecret = '';

    assert.throws(
      () => {
        env.validateForProduction();
      },
      (err) => {
        return err.message.includes('CRITICAL: Server cannot start in production mode');
      }
    );

    // Restore
    env.nodeEnv = originalNodeEnv;
    env.metaAppSecret = originalSecret;
  });

  test('passes validation when all required env vars are supplied', () => {
    const originalConfig = { ...env };

    env.nodeEnv = 'production';
    env.metaAccessToken = 'token_123';
    env.metaPhoneNumberId = 'phone_123';
    env.metaWebhookVerifyToken = 'verify_123';
    env.metaAppSecret = 'secret_123';
    env.openRouterApiKey = 'openrouter_123';
    env.databaseUrl = 'postgres://u:p@db.example:5432/gkf';

    const result = env.validateForProduction();
    assert.strictEqual(result, true);

    // Restore
    Object.assign(env, originalConfig);
  });
});
