const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getDatabase, closeDatabase } = require('../src/db/database');
const { runMigrations } = require('../src/db/migrations');
const { createProductionBackup } = require('../scripts/backup_database');

const testDir = path.join(__dirname, '../data/test_backup_restore');
const liveDbPath = path.join(testDir, 'live_test.db');
const backupDir = path.join(testDir, 'backups');

describe('Database Production Backup & Full Disaster Recovery Restore Test', () => {
  before(() => {
    closeDatabase();
    if (fs.existsSync(testDir)) {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) {}
    }
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
  });

  after(() => {
    closeDatabase();
    if (fs.existsSync(testDir)) {
      try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  test('end-to-end disaster recovery: live DB -> populate -> backup -> destroy live DB -> restore -> verify all records and FK constraints', async () => {
    // 1. Create a realistic production-like live database
    const liveDb = new DatabaseSync(liveDbPath);
    liveDb.exec('PRAGMA journal_mode = WAL;');
    liveDb.exec('PRAGMA foreign_keys = ON;');
    liveDb.exec('PRAGMA busy_timeout = 5000;');

    // Run migrations
    runMigrations(liveDb);

    // 2. Insert realistic seed data: tenant, lead, messages, handoff, audit log
    const now = new Date().toISOString();
    liveDb.prepare(`
      INSERT INTO tenants (id, name, status, timezone, configuration_json, created_at, updated_at)
      VALUES ('gym_titan', 'Titan Heavy Athletics', 'active', 'Asia/Kolkata', '{"pricing_monthly": 4500}', ?, ?)
    `).run(now, now);

    liveDb.prepare(`
      INSERT INTO leads (tenant_id, wa_id, display_name, status, interest, source, first_contact_at, last_inbound_message_at, needs_human, created_at, updated_at)
      VALUES ('gym_titan', '919555555555', 'Marcus Strong', 'qualified', 'powerlifting', 'whatsapp_inbound', ?, ?, 1, ?, ?)
    `).run(now, now, now, now);

    liveDb.prepare(`
      INSERT INTO messages (message_id, tenant_id, wa_id, direction, text, timestamp, created_at)
      VALUES ('msg_titan_in_01', 'gym_titan', '919555555555', 'in', 'Do you have calibrated competition plates?', ?, ?)
    `).run(now, now);

    liveDb.prepare(`
      INSERT INTO messages (message_id, tenant_id, wa_id, direction, text, timestamp, created_at)
      VALUES ('msg_titan_out_01', 'gym_titan', '919555555555', 'out', 'Yes, we have IPF-approved Eleiko plates and combo racks.', ?, ?)
    `).run(now, now);

    liveDb.prepare(`
      INSERT INTO handoffs (tenant_id, wa_id, status, reason, summary, created_at, updated_at)
      VALUES ('gym_titan', '919555555555', 'pending', 'custom_program', 'Interested in meet preparation coaching', ?, ?)
    `).run(now, now);

    liveDb.prepare(`
      INSERT INTO audit_logs (tenant_id, actor_id, actor_role, action, target_type, target_id, changes_json, created_at)
      VALUES ('gym_titan', 'staff_coach', 'staff', 'lead_update', 'lead', '919555555555', '{"status":"qualified"}', ?)
    `).run(now);

    liveDb.close();

    // 3. Perform atomic backup using production procedure
    const backupDbInstance = getDatabase(liveDbPath);
    const backupResult = await createProductionBackup(backupDir);

    assert.strictEqual(backupResult.success, true);
    assert.ok(fs.existsSync(backupResult.path));
    assert.ok(backupResult.sizeBytes > 0);

    // Verify backup integrity right after creation
    const backupCheckDb = new DatabaseSync(backupResult.path);
    const checkRow = backupCheckDb.prepare('PRAGMA integrity_check;').get();
    assert.strictEqual(Object.values(checkRow)[0], 'ok');
    backupCheckDb.close();

    // 4. Catastrophic disaster simulation: destroy the live database files
    closeDatabase();
    fs.unlinkSync(liveDbPath);
    if (fs.existsSync(`${liveDbPath}-wal`)) fs.unlinkSync(`${liveDbPath}-wal`);
    if (fs.existsSync(`${liveDbPath}-shm`)) fs.unlinkSync(`${liveDbPath}-shm`);

    assert.strictEqual(fs.existsSync(liveDbPath), false, 'Live DB must be destroyed');

    // 5. Restore procedure: copy verified backup to live DB location
    fs.copyFileSync(backupResult.path, liveDbPath);
    assert.ok(fs.existsSync(liveDbPath), 'Restored DB file must exist');

    // 6. Start application database connection against restored file
    const restoredDb = getDatabase(liveDbPath);

    // 7. Verify all schema migrations survived intact
    const migrationsCount = restoredDb.prepare('SELECT COUNT(*) as count FROM schema_migrations').get().count;
    assert.strictEqual(migrationsCount, 5, 'All 5 migrations must be registered');

    // 8. Verify foreign key integrity
    const fkErrors = restoredDb.prepare('PRAGMA foreign_key_check;').all();
    assert.strictEqual(fkErrors.length, 0, 'Restored database must have zero foreign key violations');

    // 9. Verify all records survived intact
    const restoredTenant = restoredDb.prepare('SELECT * FROM tenants WHERE id = ?').get('gym_titan');
    assert.ok(restoredTenant);
    assert.strictEqual(restoredTenant.name, 'Titan Heavy Athletics');

    const restoredLead = restoredDb.prepare('SELECT * FROM leads WHERE tenant_id = ? AND wa_id = ?').get('gym_titan', '919555555555');
    assert.ok(restoredLead);
    assert.strictEqual(restoredLead.display_name, 'Marcus Strong');
    assert.strictEqual(restoredLead.status, 'qualified');

    const restoredMessages = restoredDb.prepare('SELECT * FROM messages WHERE tenant_id = ? AND wa_id = ? ORDER BY id ASC').all('gym_titan', '919555555555');
    assert.strictEqual(restoredMessages.length, 2);
    assert.strictEqual(restoredMessages[0].text, 'Do you have calibrated competition plates?');
    assert.strictEqual(restoredMessages[1].text, 'Yes, we have IPF-approved Eleiko plates and combo racks.');

    const restoredHandoff = restoredDb.prepare('SELECT * FROM handoffs WHERE tenant_id = ? AND wa_id = ?').get('gym_titan', '919555555555');
    assert.ok(restoredHandoff);
    assert.strictEqual(restoredHandoff.reason, 'custom_program');

    const restoredAudit = restoredDb.prepare('SELECT * FROM audit_logs WHERE tenant_id = ?').get('gym_titan');
    assert.ok(restoredAudit);
    assert.strictEqual(restoredAudit.actor_id, 'staff_coach');

    // 10. Verify write operations succeed on restored DB with FK enforcement
    restoredDb.prepare(`
      INSERT INTO messages (message_id, tenant_id, wa_id, direction, text, timestamp, created_at)
      VALUES ('msg_titan_in_02', 'gym_titan', '919555555555', 'in', 'Can I visit tomorrow?', datetime('now'), datetime('now'))
    `).run();

    const newMsg = restoredDb.prepare('SELECT * FROM messages WHERE message_id = ?').get('msg_titan_in_02');
    assert.ok(newMsg);

    // Foreign key violation must throw
    assert.throws(() => {
      restoredDb.prepare(`
        INSERT INTO messages (message_id, tenant_id, wa_id, direction, text, timestamp, created_at)
        VALUES ('msg_orphan_fail', 'gym_titan', '910000000000', 'in', 'Orphan message', datetime('now'), datetime('now'))
      `).run();
    }, /FOREIGN KEY constraint failed/);

    closeDatabase();
  });

  test('corrupted backup files are detected and rejected by integrity check', () => {
    const corruptBackupPath = path.join(backupDir, 'corrupt_test.db');
    // Write 512 bytes of invalid random garbage
    fs.writeFileSync(corruptBackupPath, Buffer.from('NOT A VALID SQLITE DATABASE HEADER GARBAGE DATA 1234567890'.repeat(10)));

    let integrityFailed = false;
    try {
      const corruptDb = new DatabaseSync(corruptBackupPath);
      const row = corruptDb.prepare('PRAGMA integrity_check;').get();
      corruptDb.close();
      const val = Object.values(row)[0];
      if (val !== 'ok') integrityFailed = true;
    } catch (err) {
      integrityFailed = true;
    }

    assert.strictEqual(integrityFailed, true, 'Corrupted database file must fail integrity verification');
    if (fs.existsSync(corruptBackupPath)) {
      try { fs.unlinkSync(corruptBackupPath); } catch (e) {}
    }
  });
});
