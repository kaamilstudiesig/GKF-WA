const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getDatabase, closeDatabase } = require('../src/db/database');
const env = require('../src/config/env');
const logger = require('../src/utils/logger');
const { captureException } = require('../src/utils/sentry');

let BlobServiceClient = null;
try {
  const azure = require('@azure/storage-blob');
  BlobServiceClient = azure.BlobServiceClient;
} catch (e) {
  // @azure/storage-blob optional in non-cloud dev environments
}

/**
 * Uploads a verified local backup file to Azure Blob Storage
 */
async function uploadToAzureStorage(backupFilePath, backupFileName) {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const containerName = process.env.AZURE_BACKUP_CONTAINER || 'gkf-wa-backups';

  if (!connectionString) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('AZURE_STORAGE_CONNECTION_STRING not set. Offsite cloud copy skipped; local verified snapshot preserved.');
    }
    return { uploaded: false, reason: 'unconfigured' };
  }

  if (!BlobServiceClient) {
    const msg = '@azure/storage-blob is not installed. Cannot perform offsite Azure backup upload.';
    logger.error(msg);
    if (process.env.NODE_ENV === 'production') {
      throw new Error(msg);
    }
    return { uploaded: false, reason: 'missing_sdk' };
  }

  try {
    const startTime = Date.now();
    logger.info('Initiating offsite backup upload to Azure Blob Storage...', {
      container: containerName,
      blob: backupFileName
    });

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    // Ensure backup container exists
    await containerClient.createIfNotExists();

    const blockBlobClient = containerClient.getBlockBlobClient(backupFileName);
    await blockBlobClient.uploadFile(backupFilePath);

    const uploadDurationMs = Date.now() - startTime;
    logger.info('Offsite Azure backup upload completed successfully!', {
      container: containerName,
      blob: backupFileName,
      duration_ms: uploadDurationMs
    });

    // Prune old backups in Azure container (keep last 14 backups)
    await pruneOldAzureBackups(containerClient, 14);

    return {
      uploaded: true,
      container: containerName,
      blob: backupFileName,
      durationMs: uploadDurationMs
    };
  } catch (err) {
    logger.error('CRITICAL: Offsite Azure Blob Storage backup upload failed!', {
      error: err.message,
      container: containerName,
      blob: backupFileName
    });

    captureException(err, {
      component: 'azure_backup_upload',
      container: containerName,
      blob: backupFileName
    });

    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Production offsite backup failed: ${err.message}`);
    }

    return { uploaded: false, error: err.message };
  }
}

/**
 * Prunes older backups from Azure Blob container to avoid unbounded cloud storage
 */
async function pruneOldAzureBackups(containerClient, keepCount = 14) {
  try {
    const blobs = [];
    for await (const blob of containerClient.listBlobsFlat({ prefix: 'backup-' })) {
      if (blob.name.endsWith('.db')) {
        blobs.push({
          name: blob.name,
          createdOn: blob.properties.createdOn || new Date(0)
        });
      }
    }

    if (blobs.length > keepCount) {
      blobs.sort((a, b) => b.createdOn - a.createdOn);
      const toDelete = blobs.slice(keepCount);
      for (const item of toDelete) {
        await containerClient.deleteBlob(item.name);
        logger.debug('Pruned aged offsite Azure backup archive', { blob: item.name });
      }
    }
  } catch (e) {
    logger.warn('Failed to prune old Azure blob backups:', { error: e.message });
  }
}

/**
 * Production SQLite Backup Procedure:
 * Uses SQLite's native atomic VACUUM INTO to create an exact, uncorrupted
 * snapshot of the live database even while active transactions run in WAL mode.
 * Performs immediate PRAGMA integrity_check on the resulting backup file.
 * Copies the verified snapshot to offsite object storage if configured.
 */
async function createProductionBackup(customBackupDir = null) {
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
    const localDurationMs = Date.now() - startTime;

    logger.info('Local database backup completed and verified successfully!', {
      file: backupFileName,
      size_bytes: stats.size,
      size_mb: parseFloat((stats.size / (1024 * 1024)).toFixed(3)),
      integrity: 'ok',
      duration_ms: localDurationMs
    });

    // 3. Prune old local backups (keep last 14 backups by default)
    pruneOldBackups(backupDir, 14);

    // 4. Offsite Azure upload (if configured)
    const azureResult = await uploadToAzureStorage(backupFilePath, backupFileName);

    return {
      success: true,
      path: backupFilePath,
      sizeBytes: stats.size,
      durationMs: Date.now() - startTime,
      azure: azureResult
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
        logger.debug('Pruned aged local backup archive', { file: item.name });
      }
    }
  } catch (e) {
    logger.warn('Failed to prune older local backups:', { error: e.message });
  }
}

// Execute directly if run via node CLI
if (require.main === module) {
  createProductionBackup()
    .then(() => {
      closeDatabase();
      process.exit(0);
    })
    .catch((err) => {
      logger.error('Production backup execution halted with error:', { error: err.message });
      closeDatabase();
      process.exit(1);
    });
}

module.exports = {
  createProductionBackup,
  uploadToAzureStorage,
  pruneOldBackups
};
