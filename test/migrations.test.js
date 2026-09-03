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
});
