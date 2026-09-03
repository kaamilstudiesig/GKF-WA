const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getDatabase, closeDatabase } = require('../src/db/database');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');

/**
 * Production SQLite Backup Procedure:
 * Uses SQLite's native atomic VACUUM INTO to create an exact, uncorrupted
 * snapshot of the live database even while active transactions run in WAL mode.
 * Performs immediate PRAGMA integrity_check on the resulting backup file.
 */
function createProductionBackup(customBackupDir = null) {
  const startTime = Date.now();
  const backupDir = customBackupDir || process.env.BACKUP_DIR || path.join(__dirname, '../data/backups');

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFileName = `backup-${timestamp}.db`;
  const backupFilePath = path.join(backupDir, backupFileName);

  logger.info('Initiating live SQLite atomic backup...', { target: backupFilePath });

  const liveDb = getDatabase();

  try {
    // 1. Run atomic snapshot
    liveDb.exec(`VACUUM INTO '${backupFilePath}';`);

    // 2. Open the snapshot and verify structural integrity
    const backupDb = new DatabaseSync(backupFilePath);
    const integrityRow = backupDb.prepare('PRAGMA integrity_check;').get();
    backupDb.close();

    const isOk = integrityRow && Object.values(integrityRow)[0] === 'ok';
    if (!isOk) {
      throw new Error(`Backup failed integrity check: ${JSON.stringify(integrityRow)}`);
    }

    const stats = fs.statSync(backupFilePath);
    const durationMs = Date.now() - startTime;

    logger.info('Database backup completed and verified successfully!', {
      file: backupFileName,
      size_bytes: stats.size,
      size_mb: parseFloat((stats.size / (1024 * 1024)).toFixed(3)),
      integrity: 'ok',
      duration_ms: durationMs
    });

    // 3. Prune old backups (keep last 14 backups by default)
    pruneOldBackups(backupDir, 14);

    return {
      success: true,
      path: backupFilePath,
      sizeBytes: stats.size,
      durationMs
    };
  } catch (err) {
    logger.error('SQLite backup failed:', { error: err.message });
    if (fs.existsSync(backupFilePath)) {
      try { fs.unlinkSync(backupFilePath); } catch (e) {}
    }
    throw err;
  }
}

/**
 * Prunes older backup files to maintain bounded storage
 */
function pruneOldBackups(backupDir, keepCount = 14) {
  try {
    const files = fs.readdirSync(backupDir)
      .filter(f => f.startsWith('backup-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        fullPath: path.join(backupDir, f),
        time: fs.statSync(path.join(backupDir, f)).mtimeMs
      }))
      .sort((a, b) => b.time - a.time);

    if (files.length > keepCount) {
      const toDelete = files.slice(keepCount);
      for (const item of toDelete) {
        fs.unlinkSync(item.fullPath);
        logger.debug('Pruned aged backup archive', { file: item.name });
      }
    }
  } catch (e) {
    logger.warn('Failed to prune older backups:', { error: e.message });
  }
}

// Execute directly if run via node CLI
if (require.main === module) {
  try {
    createProductionBackup();
    closeDatabase();
    process.exit(0);
  } catch (e) {
    closeDatabase();
    process.exit(1);
  }
}

module.exports = {
  createProductionBackup,
  pruneOldBackups
};
