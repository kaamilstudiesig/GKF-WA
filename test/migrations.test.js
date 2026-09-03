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

  test('exact production sequence: migrations 1-4 with foreign keys enabled, legacy data, then production init applying migration 005', () => {
    const prodDbPath = path.join(__dirname, '../data/test_prod_migration_sequence.db');
    if (fs.existsSync(prodDbPath)) {
      try { fs.unlinkSync(prodDbPath); } catch (e) {}
    }

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(prodDbPath);

    // 1 & 2: Real app connection pragmas with foreign keys ON
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');

    // Apply only migrations 1 through 4
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    for (let i = 0; i < 4; i++) {
      db.exec('PRAGMA foreign_keys = OFF;');
      db.exec('BEGIN IMMEDIATE;');
      migrations[i].up(db);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        migrations[i].name,
        new Date().toISOString()
      );
      db.exec('COMMIT;');
      db.exec('PRAGMA foreign_keys = ON;');
    }

    assert.strictEqual(db.prepare('PRAGMA foreign_keys;').get().foreign_keys, 1);

    // 3. Insert realistic legacy records
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO leads (wa_id, tenant_id, display_name, status, interest, source, first_contact_at, last_inbound_message_at, created_at, updated_at)
      VALUES ('919888888888', 'goldkraft', 'Legacy John', 'qualified', 'weight_loss', 'whatsapp_inbound', ?, ?, ?, ?)
    `).run(now, now, now, now);

    db.prepare(`
      INSERT INTO messages (message_id, tenant_id, wa_id, direction, text, timestamp, created_at)
      VALUES ('msg_legacy_real_01', 'goldkraft', '919888888888', 'in', 'Hi Goldkraft', ?, ?)
    `).run(now, now);

    db.prepare(`
      INSERT INTO handoffs (tenant_id, wa_id, status, reason, summary, created_at, updated_at)
      VALUES ('goldkraft', '919888888888', 'pending', 'price_negotiation', 'Wants discount', ?, ?)
    `).run(now, now);

    db.close();

    // 4 & 5: Run the normal production database initialization path (which will apply migration 005)
    closeDatabase();
    const prodDb = getDatabase(prodDbPath);

    // 6. Verification:
    // a. All migrations applied
    const applied = prodDb.prepare('SELECT name FROM schema_migrations ORDER BY id ASC').all();
    assert.strictEqual(applied.length, migrations.length);
    assert.strictEqual(applied[4].name, '005_composite_tenant_leads_and_fk_safety');

    // b. All existing data survives and tenant_id preserved
    const lead = prodDb.prepare('SELECT * FROM leads WHERE wa_id = ? AND tenant_id = ?').get('919888888888', 'goldkraft');
    assert.ok(lead, 'Legacy lead must survive');
    assert.strictEqual(lead.display_name, 'Legacy John');
    assert.strictEqual(lead.status, 'qualified');

    const msg = prodDb.prepare('SELECT * FROM messages WHERE message_id = ?').get('msg_legacy_real_01');
    assert.ok(msg, 'Legacy message must survive');
    assert.strictEqual(msg.tenant_id, 'goldkraft');
    assert.strictEqual(msg.wa_id, '919888888888');

    const handoff = prodDb.prepare('SELECT * FROM handoffs WHERE wa_id = ?').get('919888888888');
    assert.ok(handoff, 'Legacy handoff must survive');
    assert.strictEqual(handoff.tenant_id, 'goldkraft');
    assert.strictEqual(handoff.reason, 'price_negotiation');

    // c. Another tenant can reuse the exact same wa_id
    prodDb.exec("INSERT INTO tenants (id, name, created_at, updated_at) VALUES ('tenant_silver', 'Silver Gym', datetime('now'), datetime('now'));");
    prodDb.prepare(`
      INSERT INTO leads (tenant_id, wa_id, display_name, status, first_contact_at, last_inbound_message_at, created_at, updated_at)
      VALUES ('tenant_silver', '919888888888', 'Silver John', 'new', datetime('now'), datetime('now'), datetime('now'), datetime('now'))
    `).run();

    const silverLead = prodDb.prepare('SELECT * FROM leads WHERE wa_id = ? AND tenant_id = ?').get('919888888888', 'tenant_silver');
    assert.ok(silverLead);
    assert.strictEqual(silverLead.display_name, 'Silver John');

    // d. Foreign key enforcement remains enabled afterward
    assert.strictEqual(prodDb.prepare('PRAGMA foreign_keys;').get().foreign_keys, 1);

    // e. Foreign keys reject orphan messages
    assert.throws(() => {
      prodDb.prepare(`
        INSERT INTO messages (message_id, tenant_id, wa_id, direction, text, timestamp, created_at)
        VALUES ('msg_orphan_01', 'goldkraft', '910000000000', 'in', 'Orphan text', datetime('now'), datetime('now'))
      `).run();
    }, /FOREIGN KEY constraint failed/);

    // f. Foreign keys reject orphan handoffs
    assert.throws(() => {
      prodDb.prepare(`
        INSERT INTO handoffs (tenant_id, wa_id, status, reason, created_at, updated_at)
        VALUES ('goldkraft', '910000000000', 'pending', 'other', datetime('now'), datetime('now'))
      `).run();
    }, /FOREIGN KEY constraint failed/);

    // g. Cascading delete works cleanly
    prodDb.prepare('DELETE FROM leads WHERE wa_id = ? AND tenant_id = ?').run('919888888888', 'goldkraft');
    const msgAfter = prodDb.prepare('SELECT * FROM messages WHERE message_id = ?').get('msg_legacy_real_01');
    const handoffAfter = prodDb.prepare('SELECT * FROM handoffs WHERE wa_id = ? AND tenant_id = ?').get('919888888888', 'goldkraft');
    assert.strictEqual(msgAfter, undefined, 'Messages must cascade on lead delete');
    assert.strictEqual(handoffAfter, undefined, 'Handoffs must cascade on lead delete');

    closeDatabase();
    if (fs.existsSync(prodDbPath)) {
      try { fs.unlinkSync(prodDbPath); } catch (e) {}
    }
  });
});
