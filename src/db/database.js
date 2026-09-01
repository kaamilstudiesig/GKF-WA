const fs = require('fs');
const path = require('path');
const env = require('../config/env');

let dbInstance = null;

function createDatabaseConnection(dbPath) {
  // First try Node's native built-in node:sqlite (Node 22+)
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA foreign_keys = ON;');
      } catch (e) {}
      return db;
    }
  } catch (err) {
    // node:sqlite not available, fallback to better-sqlite3
  }

  try {
    const BetterSqlite3 = require('better-sqlite3');
    const db = new BetterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (err) {
    throw new Error(`Failed to initialize SQLite database: ${err.message}`);
  }
}

function getDatabase(customPath = null) {
  if (dbInstance && !customPath) {
    return dbInstance;
  }

  const dbPath = customPath || env.databasePath;
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = createDatabaseConnection(dbPath);

  // Initialize Schema
  initSchema(db);

  if (!customPath) {
    dbInstance = db;
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      wa_id TEXT PRIMARY KEY,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost')),
      interest TEXT,
      source TEXT NOT NULL DEFAULT 'whatsapp_inbound',
      first_contact_at TEXT NOT NULL,
      last_inbound_message_at TEXT NOT NULL,
      last_outbound_message_at TEXT,
      needs_human INTEGER NOT NULL DEFAULT 0,
      handoff_reason TEXT,
      notes TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      wa_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      raw_payload TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (wa_id) REFERENCES leads(wa_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_needs_human ON leads(needs_human);
    CREATE INDEX IF NOT EXISTS idx_leads_last_inbound ON leads(last_inbound_message_at);
    CREATE INDEX IF NOT EXISTS idx_messages_wa_id ON messages(wa_id);
    CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id);
  `);
}

function closeDatabase() {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {}
    dbInstance = null;
  }
}

module.exports = {
  getDatabase,
  closeDatabase,
  initSchema
};
