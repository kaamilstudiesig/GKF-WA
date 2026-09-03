const fs = require('fs');
const path = require('path');
const env = require('../config/env');
const { runMigrations } = require('./migrations');

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
        db.exec('PRAGMA busy_timeout = 5000;');
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
    db.pragma('busy_timeout = 5000');
    return db;
  } catch (err) {
    throw new Error(`Failed to initialize SQLite database: ${err.message}`);
  }
}

function getDatabase(customPath = null) {
  const dbPath = customPath || env.databasePath;

  if (dbInstance) {
    if (!customPath || dbInstance._dbPath === dbPath) {
      return dbInstance;
    }
    closeDatabase();
  }

  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = createDatabaseConnection(dbPath);
  db._dbPath = dbPath;

  // Initialize and run migrations
  initSchema(db);

  dbInstance = db;
  return db;
}

function initSchema(db) {
  runMigrations(db);
}

/**
 * Runs a callback function inside an atomic SQLite transaction.
 * Compatible with both node:sqlite DatabaseSync and better-sqlite3.
 * @param {Function} fn - Synchronous callback containing DB operations
 * @param {object|null} db - Optional database instance (defaults to dbInstance)
 * @returns {*} Result of fn()
 */
function runTransaction(fn, db = null) {
  const targetDb = db || getDatabase();
  if (typeof targetDb.transaction === 'function') {
    return targetDb.transaction(fn)();
  }

  targetDb.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn(targetDb);
    targetDb.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      targetDb.exec('ROLLBACK;');
    } catch (rbErr) {}
    throw err;
  }
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
  initSchema,
  runTransaction
};

