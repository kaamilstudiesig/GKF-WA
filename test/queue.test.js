const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test_queue.db');
process.env.DATABASE_PATH = testDbPath;

const { getDatabase, closeDatabase } = require('../src/db/database');
const eventRepository = require('../src/db/eventRepository');
const outboundRepository = require('../src/db/outboundRepository');
const webhookWorker = require('../src/workers/webhookWorker');
const outboundWorker = require('../src/workers/outboundWorker');

const leadRepository = require('../src/db/leadRepository');

describe('Durable Queues & Resilient Workers', () => {
  before(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
    getDatabase(testDbPath);
    leadRepository.getOrCreateLead('919800000001', 'Queue Test User', new Date().toISOString(), 'goldkraft');
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  describe('Webhook Events Queue & Idempotency', () => {
    test('enforces atomic deduplication on event_key', () => {
      const eventKey = 'test_evt_key_001';
      const first = eventRepository.recordEvent({
        eventKey,
        tenantId: 'goldkraft',
        eventType: 'message',
        payload: { test: true }
      });
      assert.strictEqual(first.inserted, true);
      assert.ok(first.id > 0);

      // Duplicate insert with same event_key
      const second = eventRepository.recordEvent({
        eventKey,
        tenantId: 'goldkraft',
        eventType: 'message',
        payload: { test: true }
      });
      assert.strictEqual(second.inserted, false);
      assert.strictEqual(second.id, null);
    });

    test('locks next available event atomically and marks processing', () => {
      const locked = eventRepository.getNextPendingEvent(60);
      assert.ok(locked, 'Should lock pending event');
      assert.strictEqual(locked.event_key, 'test_evt_key_001');
      assert.strictEqual(locked.status, 'processing');
      assert.strictEqual(locked.attempts, 1);

      // Another worker querying immediately should receive null (no available events)
      const secondWorkerTry = eventRepository.getNextPendingEvent(60);
      assert.strictEqual(secondWorkerTry, null);
    });

    test('reclaims stale locked event after timeout expires', () => {
      // Simulate lock timeout by using a 0-second lock duration cutoff
      const reclaimed = eventRepository.getNextPendingEvent(0);
      assert.ok(reclaimed, 'Should reclaim stale locked event');
      assert.strictEqual(reclaimed.event_key, 'test_evt_key_001');
      assert.strictEqual(reclaimed.attempts, 2);

      // Mark complete
      eventRepository.completeEvent(reclaimed.id);
      const afterComplete = eventRepository.getNextPendingEvent(60);
      assert.strictEqual(afterComplete, null);
    });

    test('exponentially backs off and transitions to dead_letter after max attempts', () => {
      const eventKey = 'failing_evt_001';
      const record = eventRepository.recordEvent({
        eventKey,
        tenantId: 'goldkraft',
        eventType: 'message',
        payload: { fail: true },
        maxAttempts: 2
      });

      // Attempt 1
      const evt1 = eventRepository.getNextPendingEvent(60);
      assert.ok(evt1);
      eventRepository.failEvent(evt1.id, 'Network glitch', 0);

      // Attempt 2 (Max attempts reached)
      const evt2 = eventRepository.getNextPendingEvent(0);
      assert.ok(evt2);
      eventRepository.failEvent(evt2.id, 'Fatal database error', 0);

      const db = getDatabase(testDbPath);
      const row = db.prepare('SELECT status, attempts, last_error FROM webhook_events WHERE id = ?').get(record.id);
      assert.strictEqual(row.status, 'dead_letter');
      assert.strictEqual(row.attempts, 2);
      assert.strictEqual(row.last_error, 'Fatal database error');
    });
  });

  describe('Outbound Message Queue & Delivery', () => {
    test('enforces atomic deduplication on outbound dedup_key', () => {
      const dedupKey = 'outbound_dedup_001';
      const first = outboundRepository.enqueueOutbound({
        dedupKey,
        tenantId: 'goldkraft',
        waId: '919800000001',
        text: 'Hello from queue test'
      });
      assert.strictEqual(first.inserted, true);

      const second = outboundRepository.enqueueOutbound({
        dedupKey,
        tenantId: 'goldkraft',
        waId: '919800000001',
        text: 'Duplicate send attempt'
      });
      assert.strictEqual(second.inserted, false);
    });

    test('outbound worker accurately classifies retryable vs non-retryable errors', () => {
      // 429 rate limit -> retryable
      const rateLimitErr = { response: { status: 429, data: 'rate limit' } };
      assert.strictEqual(outboundWorker.isRetryableError(rateLimitErr), true);

      // 500 server error -> retryable
      const serverErr = { response: { status: 500, data: 'meta 500' } };
      assert.strictEqual(outboundWorker.isRetryableError(serverErr), true);

      // Network timeout (no response object) -> retryable
      const networkErr = { code: 'ETIMEDOUT', message: 'connection timeout' };
      assert.strictEqual(outboundWorker.isRetryableError(networkErr), true);

      // 400 Bad Request (invalid phone number) -> permanent failure (NOT retryable)
      const clientErr = { response: { status: 400, data: 'invalid recipient phone' } };
      assert.strictEqual(outboundWorker.isRetryableError(clientErr), false);

      // 401 Unauthorized -> permanent failure
      const authErr = { response: { status: 401, data: 'bad token' } };
      assert.strictEqual(outboundWorker.isRetryableError(authErr), false);
    });

    test('processes outbound queue job and transitions to sent state', async () => {
      const processed = await outboundWorker.processNext();
      assert.strictEqual(processed, true);

      const db = getDatabase(testDbPath);
      const row = db.prepare('SELECT status, provider_message_id FROM outbound_messages WHERE dedup_key = ?').get('outbound_dedup_001');
      assert.strictEqual(row.status, 'sent');
      assert.ok(row.provider_message_id.startsWith('wamid.simulated_'));
    });
  });
});
