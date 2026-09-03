const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const testDbPath = path.join(__dirname, '../data/test_migrations.db');

const { getDatabase, closeDatabase } = require('../src/db/database');
const { runMigrations, migrations } = require('../src/db/migrations');

describe('Database Migration Engine', () => {
  before(() => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch (e) {}
    }
  });

  test('runs all migrations successfully on a fresh database', () => {
    const db = getDatabase(testDbPath);
    const rows = db.prepare('SELECT name FROM schema_migrations ORDER BY id ASC').all();
    assert.strictEqual(rows.length, migrations.length);
    assert.strictEqual(rows[0].name, '001_initial_schema');
    assert.strictEqual(rows[1].name, '002_multi_tenancy');
    assert.strictEqual(rows[2].name, '003_durable_queues');
    assert.strictEqual(rows[3].name, '004_ai_handoffs_and_auth');
    assert.strictEqual(rows[4].name, '005_composite_tenant_leads_and_fk_safety');
  });

  test('subsequent migration calls are idempotent and do not fail or duplicate entries', () => {
    const db = getDatabase(testDbPath);
    // Call runMigrations again
    runMigrations(db);

    const rows = db.prepare('SELECT name FROM schema_migrations').all();
    assert.strictEqual(rows.length, migrations.length);
  });

  test('seeded default tenant exists and contains valid configuration', () => {
    const db = getDatabase(testDbPath);
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get('goldkraft');
    assert.ok(tenant, 'Default tenant goldkraft should exist');
    assert.strictEqual(tenant.name, 'Goldkraft Fitness');
    assert.strictEqual(tenant.timezone, 'Asia/Kolkata');

    const config = JSON.parse(tenant.configuration_json);
    assert.strictEqual(config.pricing_monthly, 4040);
  });

  test('migrates an existing pre-Phase-A database cleanly preserving data and upgrading to composite keys', () => {
    const legacyDbPath = path.join(__dirname, '../data/test_legacy_pre_phase_a.db');
    if (fs.existsSync(legacyDbPath)) {
      try { fs.unlinkSync(legacyDbPath); } catch (e) {}
    }

    const { DatabaseSync } = require('node:sqlite');
    const legacyDb = new DatabaseSync(legacyDbPath);

    // Simulate pre-Phase-A database state (no schema_migrations, global wa_id PK)
    legacyDb.exec(`
      CREATE TABLE leads (
        wa_id TEXT PRIMARY KEY,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'new',
        first_contact_at TEXT NOT NULL,
        last_inbound_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO leads VALUES ('919999999999', 'PrePhaseA Lead', 'new', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');

      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE,
        wa_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (wa_id) REFERENCES leads(wa_id)
      );

      INSERT INTO messages VALUES (1, 'msg_legacy_001', '919999999999', 'in', 'Hello from pre-phase-A', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    `);

    // Run migration runner on legacy database
    runMigrations(legacyDb);

    // 1. Verify all migrations recorded
    const migRows = legacyDb.prepare('SELECT name FROM schema_migrations ORDER BY id ASC').all();
    assert.strictEqual(migRows.length, migrations.length);

    // 2. Verify legacy records preserved with tenant_id = 'goldkraft'
    const lead = legacyDb.prepare('SELECT * FROM leads WHERE wa_id = ?').get('919999999999');
    assert.ok(lead);
    assert.strictEqual(lead.display_name, 'PrePhaseA Lead');
    assert.strictEqual(lead.tenant_id, 'goldkraft');

    const msg = legacyDb.prepare('SELECT * FROM messages WHERE message_id = ?').get('msg_legacy_001');
    assert.ok(msg);
    assert.strictEqual(msg.text, 'Hello from pre-phase-A');
    assert.strictEqual(msg.tenant_id, 'goldkraft');

    // 3. Verify that composite primary key now allows the same wa_id under another tenant!
    legacyDb.exec("INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('gym_delta', 'Delta Gym', datetime('now'), datetime('now'));");
    legacyDb.prepare(`
      INSERT INTO leads (tenant_id, wa_id, display_name, status, first_contact_at, last_inbound_message_at, created_at, updated_at)
      VALUES ('gym_delta', '919999999999', 'Delta Same Lead', 'new', datetime('now'), datetime('now'), datetime('now'), datetime('now'))
    `).run();

    const deltaLead = legacyDb.prepare('SELECT * FROM leads WHERE wa_id = ? AND tenant_id = ?').get('919999999999', 'gym_delta');
    assert.ok(deltaLead);
    assert.strictEqual(deltaLead.display_name, 'Delta Same Lead');

    legacyDb.close();
    if (fs.existsSync(legacyDbPath)) {
      try { fs.unlinkSync(legacyDbPath); } catch (e) {}
    }
  });
});
