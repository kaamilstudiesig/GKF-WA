const crypto = require('crypto');

/**
 * Tenant secrets (Meta access token, app secret, Razorpay keys...) are stored
 * encrypted in tenants.secrets with AES-256-GCM. The key is TENANT_SECRETS_KEY:
 * 32 random bytes, base64 (create one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
 * Format: "v1:<iv>:<tag>:<ciphertext>", each part base64.
 */
const VERSION = 'v1';

function key() {
  const raw = process.env.TENANT_SECRETS_KEY || '';
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('TENANT_SECRETS_KEY must be 32 bytes, base64 encoded.');
  return buf;
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj || {}), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(text) {
  if (!text) return {};
  const [v, iv, tag, data] = String(text).split(':');
  if (v !== VERSION || !iv || !tag || !data) throw new Error('Unknown tenant secrets format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

module.exports = { encrypt, decrypt };
