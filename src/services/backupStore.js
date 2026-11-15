const crypto = require('crypto');
const axios = require('axios');
const aws4 = require('aws4');

/**
 * K28: encrypted off-site backups in S3-compatible object storage (Cloudflare R2).
 *
 * Encryption: AES-256-GCM with BACKUP_ENCRYPTION_KEY (32 random bytes, base64), a key
 * of its own, not TENANT_SECRETS_KEY. File layout: "GKFB1\n" | iv (12) | tag (16) | ciphertext.
 * The plaintext is the gzipped JSON made by scripts/backup.js.
 *
 * Storage: path-style S3 requests signed with SigV4 (aws4), e.g. for R2
 *   BACKUP_S3_ENDPOINT=https://<account id>.eu.r2.cloudflarestorage.com  (EU jurisdiction)
 *   BACKUP_S3_REGION=auto, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY
 * The app only needs to write and read objects; old backups are removed by a bucket
 * lifecycle rule (30 days), so the token needs no delete permission.
 */
const MAGIC = Buffer.from('GKFB1\n');

function config() {
  const e = process.env;
  return {
    key: e.BACKUP_ENCRYPTION_KEY || '',
    endpoint: String(e.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
    region: e.BACKUP_S3_REGION || 'auto',
    bucket: e.BACKUP_S3_BUCKET || '',
    accessKeyId: e.BACKUP_S3_ACCESS_KEY_ID || '',
    secretAccessKey: e.BACKUP_S3_SECRET_ACCESS_KEY || '',
    prefix: `${String(e.BACKUP_PREFIX || e.CLIENT_ID || 'gkf').replace(/^\/+|\/+$/g, '')}/`
  };
}

/** Names of the settings that are missing; empty when backups can run. */
function missing() {
  const c = config();
  const need = {
    BACKUP_ENCRYPTION_KEY: c.key, BACKUP_S3_ENDPOINT: c.endpoint, BACKUP_S3_BUCKET: c.bucket,
    BACKUP_S3_ACCESS_KEY_ID: c.accessKeyId, BACKUP_S3_SECRET_ACCESS_KEY: c.secretAccessKey
  };
  return Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
}

function keyBytes() {
  const buf = Buffer.from(config().key, 'base64');
  if (buf.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64 encoded.');
  return buf;
}

const isEncrypted = buf => Buffer.isBuffer(buf) && buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
}

function decrypt(buf) {
  if (!isEncrypted(buf)) throw new Error('Not an encrypted backup file.');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = buf.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(buf.subarray(MAGIC.length + 28)), decipher.final()]);
  } catch {
    throw new Error('Cannot decrypt the backup: wrong BACKUP_ENCRYPTION_KEY, or the file is damaged.');
  }
}

/** The plain gzipped backup from a file that may or may not be encrypted (old backups were not). */
const toPlain = buf => (isEncrypted(buf) ? decrypt(buf) : buf);

const store = {
  transport: null, // tests: async ({ method, url, headers, body }) -> { status, data: Buffer }

  /** One signed request. `key` is the object key; `query` an object of query params. */
  async request(method, key = '', { body = null, query = null } = {}) {
    const c = config();
    const miss = missing().filter(k => k !== 'BACKUP_ENCRYPTION_KEY');
    if (miss.length) throw new Error(`Backup storage is not set up (missing ${miss.join(', ')}).`);
    const url = new URL(c.endpoint);
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const path = `/${encodeURIComponent(c.bucket)}${key ? `/${key.split('/').map(encodeURIComponent).join('/')}` : ''}${qs}`;
    const opts = aws4.sign({
      host: url.host, path, method, service: 's3', region: c.region, body: body || undefined,
      headers: body ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } : {}
    }, { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey });
    const req = { method, url: `${url.protocol}//${url.host}${path}`, headers: opts.headers, body };
    const res = this.transport ? await this.transport(req) : await axios({
      method, url: req.url, headers: req.headers, data: body || undefined, responseType: 'arraybuffer',
      timeout: 60000, maxBodyLength: Infinity, validateStatus: () => true
    }).then(r => ({ status: r.status, data: Buffer.from(r.data || []) }));
    if (res.status < 200 || res.status >= 300) {
      const text = Buffer.from(res.data || []).toString('utf8');
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new Error(`Storage ${method} failed: HTTP ${res.status}${code ? ` ${code}` : ''}`);
    }
    return Buffer.from(res.data || []);
  },

  put(key, buf) { return this.request('PUT', key, { body: buf }); },
  get(key) { return this.request('GET', key); },

  /** Object keys under a prefix (relative to the bucket), oldest first by name. */
  async list(prefix) {
    const keys = [];
    let token = null;
    do {
      const query = { 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) };
      const xml = (await this.request('GET', '', { query })).toString('utf8');
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1].replace(/&amp;/g, '&'));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : null;
    } while (token);
    return keys.sort();
  }
};

module.exports = { store, config, missing, encrypt, decrypt, isEncrypted, toPlain, MAGIC };
