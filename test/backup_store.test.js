// K28: encrypted off-site backups. Storage is a fake in-memory bucket; nothing leaves the test.
process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64'); // test-only key
process.env.BACKUP_S3_ENDPOINT = 'https://acct.eu.r2.cloudflarestorage.com';
process.env.BACKUP_S3_BUCKET = 'gkf-backups';
process.env.BACKUP_S3_ACCESS_KEY_ID = 'TEST_KEY_ID';
process.env.BACKUP_S3_SECRET_ACCESS_KEY = 'TEST_SECRET';

const { db, converse } = require('./helpers');
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const backupStore = require('../src/services/backupStore');
const dailyBackup = require('../src/services/dailyBackup');
const notifyService = require('../src/services/notifyService');
const { createBackup } = require('../scripts/backup');
const { restore, latestFromStorage } = require('../scripts/restore');

let bucket;
let requests;
let alerts;
let failPut;

function fakeBucket() {
  bucket = new Map();
  requests = [];
  failPut = false;
  backupStore.store.transport = async ({ method, url, headers, body }) => {
    requests.push({ method, url, headers });
    const u = new URL(url);
    const [, bucketName, ...rest] = u.pathname.split('/');
    assert.strictEqual(bucketName, 'gkf-backups');
    const key = rest.map(decodeURIComponent).join('/');
    if (method === 'PUT') {
      if (failPut) return { status: 403, data: Buffer.from('<Error><Code>AccessDenied</Code></Error>') };
      bucket.set(key, Buffer.from(body));
      return { status: 200, data: Buffer.alloc(0) };
    }
    if (method === 'GET' && key) return bucket.has(key) ? { status: 200, data: bucket.get(key) } : { status: 404, data: Buffer.from('<Code>NoSuchKey</Code>') };
    if (method === 'GET') {
      const prefix = u.searchParams.get('prefix') || '';
      const keys = [...bucket.keys()].filter(k => k.startsWith(prefix));
      return { status: 200, data: Buffer.from(`<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`) };
    }
    return { status: 400, data: Buffer.alloc(0) };
  };
}

beforeEach(() => {
  fakeBucket();
  dailyBackup.resetForTests();
  alerts = [];
  notifyService.sendOverride = async text => { alerts.push(text); return true; };
});
after(async () => {
  backupStore.store.transport = null;
  notifyService.sendOverride = null;
  await db.close();
});

test('backups are encrypted with their own key; tampering or a wrong key is refused', () => {
  const plain = zlib.gzipSync(Buffer.from('{"format":"gkf-wa-backup","secret":"lead chat"}'));
  const sealed = backupStore.encrypt(plain);
  assert.ok(backupStore.isEncrypted(sealed));
  assert.ok(!sealed.includes(Buffer.from('lead chat')));
  assert.ok(backupStore.decrypt(sealed).equals(plain));
  // Old unencrypted backups still open.
  assert.ok(backupStore.toPlain(plain).equals(plain));

  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => backupStore.decrypt(tampered), /wrong BACKUP_ENCRYPTION_KEY, or the file is damaged/);

  const saved = process.env.BACKUP_ENCRYPTION_KEY;
  process.env.BACKUP_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString('base64');
  try { assert.throws(() => backupStore.decrypt(sealed), /wrong BACKUP_ENCRYPTION_KEY/); } finally { process.env.BACKUP_ENCRYPTION_KEY = saved; }
});

test('storage requests are signed path-style S3 requests', async () => {
  await backupStore.store.put('gkf/2026-11-15/x.enc', Buffer.from('abc'));
  const r = requests[0];
  assert.strictEqual(r.url, 'https://acct.eu.r2.cloudflarestorage.com/gkf-backups/gkf/2026-11-15/x.enc');
  assert.match(r.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=TEST_KEY_ID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(r.headers).includes('TEST_SECRET'));
  assert.strictEqual(r.headers['X-Amz-Content-Sha256'], require('crypto').createHash('sha256').update('abc').digest('hex'));
});

test('the daily backup uploads an encrypted copy, verifies it, and restores into an empty database', async () => {
  await converse('919855555601', 'hello, what are your prices?');
  const leads = await db.many('SELECT wa_id FROM leads ORDER BY wa_id');
  assert.ok(leads.length >= 1);

  const out = await dailyBackup.runBackup(new Date('2026-11-15T22:00:00Z'));
  assert.match(out.key, /^gkf\/2026-11-15\/gkf-wa-2026-11-15T22-00-00-000Z\.json\.gz\.enc$/);
  const stored = bucket.get(out.key);
  assert.ok(backupStore.isEncrypted(stored));
  assert.ok(!stored.includes(Buffer.from('919855555601')), 'no plain lead data leaves the app');
  assert.deepStrictEqual(requests.map(r => r.method), ['PUT', 'GET']); // uploaded, then read back

  // Restore the latest from storage into an empty database.
  const latest = await latestFromStorage();
  await db.close();
  const counts = await restore(latest);
  assert.ok(counts.leads >= 1);
  assert.deepStrictEqual(await db.many('SELECT wa_id FROM leads ORDER BY wa_id'), leads);
});

test('the daily tick waits for its slot, runs once a day, and finds a backup made before a restart', async () => {
  process.env.BACKUP_HOUR_UTC = '21:30';
  assert.strictEqual(await dailyBackup.tick(new Date('2026-11-15T21:00:00Z')), null); // before the slot
  assert.strictEqual(requests.length, 0);

  const first = await dailyBackup.tick(new Date('2026-11-15T21:31:00Z'));
  assert.ok(first.key);
  assert.match(alerts[0], /Backup OK/);
  const n = requests.length;
  assert.strictEqual(await dailyBackup.tick(new Date('2026-11-15T23:00:00Z')), null); // done today: no calls
  assert.strictEqual(requests.length, n);

  // A restart forgets the in-memory record; one list call finds today's backup.
  dailyBackup.resetForTests();
  const again = await dailyBackup.tick(new Date('2026-11-15T23:30:00Z'));
  assert.strictEqual(again.skipped, true);
  assert.strictEqual(bucket.size, 1);
});

test('a failed upload alerts ops, retries later, and never marks the day done', async () => {
  failPut = true;
  const r = await dailyBackup.tick(new Date('2026-11-15T21:40:00Z'));
  assert.match(r.error, /HTTP 403 AccessDenied/);
  assert.match(alerts[0], /🚨 Backup failed: Storage PUT failed: HTTP 403 AccessDenied/);
  assert.notStrictEqual(dailyBackup.state.doneDay, '2026-11-15');
  // Retries wait 30 minutes; the alert doesn't repeat every try.
  assert.strictEqual(await dailyBackup.tick(new Date('2026-11-15T21:41:00Z')), null);
  failPut = false;
  dailyBackup.state.nextTryAt = 0;
  const ok = await dailyBackup.tick(new Date('2026-11-15T22:15:00Z'));
  assert.ok(ok.key);
  assert.strictEqual(dailyBackup.state.doneDay, '2026-11-15');
});

test('without storage settings the backup is never silent: one alert a day', async () => {
  const saved = process.env.BACKUP_S3_BUCKET;
  delete process.env.BACKUP_S3_BUCKET;
  try {
    assert.strictEqual(await dailyBackup.tick(new Date('2026-11-15T21:45:00Z')), null);
    assert.strictEqual(await dailyBackup.tick(new Date('2026-11-15T21:46:00Z')), null);
    assert.strictEqual(alerts.length, 1);
    assert.match(alerts[0], /No backup today: backups are not set up \(missing BACKUP_S3_BUCKET\)/);
    assert.strictEqual(requests.length, 0);
    await assert.rejects(dailyBackup.runBackup(), /not set up/);
  } finally { process.env.BACKUP_S3_BUCKET = saved; }
});

test('createBackup output is what gets encrypted (gzipped JSON of every table)', async () => {
  const plain = await createBackup();
  const doc = JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
  assert.strictEqual(doc.format, 'gkf-wa-backup');
});
