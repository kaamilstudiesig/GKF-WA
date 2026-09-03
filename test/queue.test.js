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

  describe('High-Throughput Batch Draining & Worker Lifecycle', () => {
    test('outbound worker drains a burst of 20 queued messages within roughly one polling tick', async () => {
      const db = getDatabase(testDbPath);
      const waId = '919800000001';

      // Enqueue 20 outbound messages
      const count = 20;
      for (let i = 0; i < count; i++) {
        outboundRepository.enqueueOutbound({
          dedupKey: `burst_msg_${i}`,
          tenantId: 'goldkraft',
          waId,
          text: `Batch message test payload #${i}`
        });
      }

      // Verify 20 items are currently pending
      const pendingBefore = db.prepare("SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'pending'").get().count;
      assert.strictEqual(pendingBefore, count);

      // Start worker with a 400ms polling interval and batch limit of 25
      outboundWorker.start(400, 25);

      // Wait ~550ms — enough for exactly one tick to fire and complete
      await new Promise(resolve => setTimeout(resolve, 550));
      await outboundWorker.stop();

      // All 20 items must now be sent (instead of only 1 item under the old 1-per-tick behavior)
      const pendingAfter = db.prepare("SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'pending'").get().count;
      const sentCount = db.prepare("SELECT COUNT(*) as count FROM outbound_messages WHERE status = 'sent' AND dedup_key LIKE 'burst_msg_%'").get().count;

      assert.strictEqual(pendingAfter, 0, 'No pending messages should remain after batch drain');
      assert.strictEqual(sentCount, count, 'All 20 queued messages should be sent in one polling tick');
    });

    test('webhook worker drains a burst of 20 queued webhook events within roughly one polling tick', async () => {
      const db = getDatabase(testDbPath);
      const count = 20;

      // Enqueue 20 delivery status events
      for (let i = 0; i < count; i++) {
        eventRepository.recordEvent({
          eventKey: `status:burst_evt_${i}:delivered`,
          tenantId: 'goldkraft',
          eventType: 'status',
          payload: {
            statuses: [{
              id: `wamid.burst_evt_${i}`,
              status: 'delivered',
              timestamp: `${Date.now()}`,
              recipient_id: '919800000001'
            }]
          }
        });
      }

      const pendingBefore = db.prepare("SELECT COUNT(*) as count FROM webhook_events WHERE status = 'pending'").get().count;
      assert.strictEqual(pendingBefore, count);

      // Start worker with a 400ms polling interval and batch limit of 25
      webhookWorker.start(400, 25);

      // Wait ~550ms — enough for roughly one tick
      await new Promise(resolve => setTimeout(resolve, 550));
      await webhookWorker.stop();

      const pendingAfter = db.prepare("SELECT COUNT(*) as count FROM webhook_events WHERE status = 'pending'").get().count;
      const completedCount = db.prepare("SELECT COUNT(*) as count FROM webhook_events WHERE status = 'completed' AND event_key LIKE 'status:burst_evt_%'").get().count;

      assert.strictEqual(pendingAfter, 0, 'No pending webhook events should remain after batch drain');
      assert.strictEqual(completedCount, count, 'All 20 events should be completed in one polling tick');
    });

    test('stop() safely waits for in-flight work and halts background interval', async () => {
      outboundWorker.start(200, 10);
      assert.strictEqual(outboundWorker.isRunning, true);
      assert.ok(outboundWorker.timer !== null);

      await outboundWorker.stop();
      assert.strictEqual(outboundWorker.isRunning, false);
      assert.strictEqual(outboundWorker.timer, null);
      assert.strictEqual(outboundWorker.isProcessing, false);
    });
  });
});
