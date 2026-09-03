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

// Test hook for simulating Azure upload behavior
let azureUploadOverride = null;

/**
 * Uploads a verified local backup file to Azure Blob Storage
 */
async function uploadToAzureStorage(backupFilePath, backupFileName) {
  if (azureUploadOverride) {
    return azureUploadOverride(backupFilePath, backupFileName);
  }

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
    captureException(new Error(msg), { component: 'azure_backup_upload' });
    return { uploaded: false, error: msg };
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
 * 1. Uses SQLite's native atomic VACUUM INTO to create an exact snapshot.
 * 2. Performs immediate PRAGMA integrity_check on the resulting backup file.
 *    If local backup or integrity fails: incomplete file is deleted and error is thrown.
 * 3. Once local backup succeeds, the verified local file is KEPT permanently.
 * 4. Attempts offsite Azure upload.
 *    If Azure fails: local backup is NEVER deleted. The failure is logged,
 *    captured in Sentry, and an error is thrown indicating partial failure.
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
  let stats = null;
  let localDurationMs = 0;

  // Phase 1: Local Backup Creation & Integrity Verification
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

    stats = fs.statSync(backupFilePath);
    localDurationMs = Date.now() - startTime;

    logger.info('Local database backup completed and verified successfully!', {
      file: backupFileName,
      size_bytes: stats.size,
      size_mb: parseFloat((stats.size / (1024 * 1024)).toFixed(3)),
      integrity: 'ok',
      duration_ms: localDurationMs
    });

    // 3. Prune old local backups (keep last 14 backups by default)
    pruneOldBackups(backupDir, 14);
  } catch (localErr) {
    logger.error('SQLite local backup creation failed:', { error: localErr.message });
    if (fs.existsSync(backupFilePath)) {
      try { fs.unlinkSync(backupFilePath); } catch (e) {}
    }
    throw localErr;
  }

  // Phase 2: Offsite Azure Upload (Local backup is now verified and MUST BE PRESERVED)
  let azureResult = null;
  let azureError = null;

  try {
    azureResult = await uploadToAzureStorage(backupFilePath, backupFileName);
    if (azureResult && azureResult.uploaded === false && azureResult.reason !== 'unconfigured') {
      azureError = new Error(azureResult.error || 'Azure offsite upload failed');
    }
  } catch (err) {
    azureError = err;
    azureResult = { uploaded: false, error: err.message };
  }

  // If Azure upload failed when configured
  if (azureError) {
    logger.error('Database backup partial failure: Local backup succeeded, but offsite Azure upload failed!', {
      file: backupFileName,
      local_path: backupFilePath,
      local_status: 'SUCCESS',
      offsite_status: 'FAILED',
      error: azureError.message
    });

    captureException(azureError, {
      component: 'azure_backup_upload',
      localBackupPath: backupFilePath
    });

    const partialFailureResult = {
      success: false,
      overallStatus: 'FAILED',
      localStatus: 'SUCCESS',
      offsiteStatus: 'FAILED',
      path: backupFilePath,
      sizeBytes: stats.size,
      durationMs: Date.now() - startTime,
      azure: azureResult,
      error: azureError.message
    };

    // NOTE: We deliberately DO NOT delete backupFilePath! Local recovery point is preserved.
    const failureErr = new Error(`Production backup partial failure: Offsite Azure upload failed (${azureError.message}). Local backup was preserved at ${backupFilePath}`);
    failureErr.backupResult = partialFailureResult;
    throw failureErr;
  }

  // Overall Success
  return {
    success: true,
    overallStatus: 'SUCCESS',
    localStatus: 'SUCCESS',
    offsiteStatus: azureResult?.uploaded ? 'SUCCESS' : 'SKIPPED',
    path: backupFilePath,
    sizeBytes: stats.size,
    durationMs: Date.now() - startTime,
    azure: azureResult
  };
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
    .then((result) => {
      closeDatabase();
      console.log('Database backup completed:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      closeDatabase();
      logger.error('Production backup execution halted with error:', { error: err.message });
      if (err.backupResult) {
        console.error('Backup summary (LOCAL PRESERVED / OFFSITE FAILED):', JSON.stringify(err.backupResult, null, 2));
      }
      process.exit(1);
    });
}

module.exports = {
  createProductionBackup,
  uploadToAzureStorage,
  pruneOldBackups,
  _setAzureUploaderForTesting: (fn) => { azureUploadOverride = fn; },
  _resetAzureUploaderForTesting: () => { azureUploadOverride = null; }
};
