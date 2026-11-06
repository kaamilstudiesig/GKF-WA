#!/usr/bin/env node
/**
 * Adds and manages client businesses (tenants) on this one deployment (K8).
 *
 *   npm run tenant -- list
 *   npm run tenant -- add clients/acme.json      # see clients/tenant.example.json
 *   npm run tenant -- set acme clients/acme.json # change settings or secrets (merged)
 *   npm run tenant -- suspend acme               # stops replies, alerts and CRM access
 *   npm run tenant -- activate acme
 *
 * On Heroku: heroku run npm run tenant -- list -a gkf-wa
 * (copy the JSON file in with `heroku run bash` or pass the values as below).
 * Secrets (tokens, app secret, Razorpay keys) are stored encrypted with
 * TENANT_SECRETS_KEY and are never printed.
 */
const crypto = require('crypto');
const fs = require('fs');
const db = require('../src/db');
const { migrateAll } = require('../src/migrate');
const tenancy = require('../src/tenancy/context');
const registry = require('../src/tenancy/registry');
const businessProfile = require('../src/services/businessProfile');

const USAGE = 'Usage: npm run tenant -- list | add <file.json> | set <slug> <file.json> | suspend <slug> | activate <slug>';

/** A tenant from the JSON file format (clients/tenant.example.json). Empty values are dropped. */
function fromFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const clean = obj => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  return {
    slug: raw.slug, name: raw.name, type: raw.type,
    phoneNumberId: raw.phoneNumberId || undefined, wabaId: raw.wabaId || undefined, crmHost: raw.crmHost || undefined,
    settings: clean(raw.settings), secrets: clean(raw.secrets)
  };
}

function show(t) {
  return {
    id: t.id, slug: t.slug, name: t.name, status: t.status,
    whatsapp_number_id: t.whatsapp.phoneNumberId || '(not set)',
    waba_id: t.whatsapp.wabaId || '(not set)',
    crm: t.crm.host || (t.isDefault ? 'CRM_HOSTS' : '(not set)'),
    token: t.whatsapp.accessToken ? 'set' : 'missing',
    app_secret: t.whatsapp.appSecret ? 'set' : 'missing',
    staff_alerts_telegram: t.telegram.chatId ? 'set' : 'off',
    payments: t.razorpay.keyId ? 'set' : 'off'
  };
}

function nextSteps(t, verifyToken) {
  const host = process.env.HEROKU_APP_NAME ? `${process.env.HEROKU_APP_NAME}.herokuapp.com` : '<this app host>';
  return `
Next steps for ${t.name} (${t.slug}):
1. Meta webhook (the client's own Meta app, path A): callback URL
     https://${host}/webhook/${t.slug}
   verify token: ${verifyToken ? verifyToken : '(the one you stored)'}
   Subscribe the fields: messages, account_update, phone_number_quality_update, account_alerts.
2. CRM address: heroku domains:add ${t.crm.host || '<crm host>'} -a <app>, then point DNS at the target it prints.
3. Owner login: npm run crm:owner -- --tenant ${t.slug} "Owner Name" owner@client.com
4. Business facts: log in to the CRM -> Business settings. Until then the assistant uses placeholders.
5. Test from a phone that never messaged this number (docs/ONBOARDING.md checklist).`;
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (!cmd) throw new Error(USAGE);
  await migrateAll();
  await registry.load();

  if (cmd === 'list') {
    console.table(registry.list().map(show));
    return;
  }
  if (cmd === 'add') {
    if (!a) throw new Error(USAGE);
    const input = fromFile(a);
    let generated = null;
    if (!input.secrets.metaVerifyToken) { // Meta needs one for the webhook handshake
      generated = crypto.randomBytes(18).toString('base64url');
      input.secrets.metaVerifyToken = generated;
    }
    const t = await registry.create(input);
    // A neutral starting profile of the right business type (never another client's facts).
    await tenancy.run(t.id, () => businessProfile.save(businessProfile.starterProfile({ name: t.name, type: input.type }), 'tenant:add'));
    console.log('Tenant created:'); console.table([show(t)]);
    console.log(nextSteps(t, generated));
    return;
  }
  if (cmd === 'set') {
    if (!a || !b) throw new Error(USAGE);
    const tenant = await registry.bySlug(a);
    if (!tenant) throw new Error(`No tenant "${a}"`);
    const input = fromFile(b);
    const t = await registry.update(tenant.id, input);
    console.log('Tenant updated:'); console.table([show(t)]);
    return;
  }
  if (cmd === 'suspend' || cmd === 'activate') {
    const tenant = await registry.bySlug(a);
    if (!tenant) throw new Error(`No tenant "${a}"`);
    if (tenant.isDefault && cmd === 'suspend') throw new Error('Tenant 1 cannot be suspended here; scale the app down instead.');
    const t = await registry.update(tenant.id, { status: cmd === 'suspend' ? 'suspended' : 'active' });
    console.log(`${t.slug} is now ${t.status}.`);
    return;
  }
  throw new Error(USAGE);
}

if (require.main === module) {
  main()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch(async err => { console.error(err.message); await db.close().catch(() => {}); process.exit(1); });
}

module.exports = { fromFile, show };
