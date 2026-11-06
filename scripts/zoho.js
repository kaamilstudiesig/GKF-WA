#!/usr/bin/env node
/**
 * K20: connect a client's Zoho CRM, check it, and send existing leads.
 *
 *   ZOHO_CLIENT_ID=... ZOHO_CLIENT_SECRET=... ZOHO_CODE=... \
 *     npm run zoho -- --tenant <slug> connect --accounts https://accounts.zoho.in [--id-field Lead_Engine_ID] [--pipeline "Standard (Standard)"]
 *   npm run zoho -- --tenant <slug> status
 *   npm run zoho -- --tenant <slug> backfill [--days 30 | --all]
 *   npm run zoho -- --tenant <slug> off
 *
 * Secrets come from env vars (not flags) so they stay out of shell history. ZOHO_CODE is the
 * one-time grant code from the Zoho API console (Self Client), scopes in docs/ONBOARDING.md.
 * Needs DATABASE_URL and TENANT_SECRETS_KEY. Never prints a token or secret.
 */
require('dotenv').config({ quiet: true });
const db = require('../src/db');
const tenancy = require('../src/tenancy/context');
const registry = require('../src/tenancy/registry');
const zoho = require('../src/services/zoho/client');
const { tenantFromArgs } = require('./lib/tenantArg');

const flag = (args, name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function connect(tenant, args) {
  const accountsUrl = flag(args, '--accounts') || 'https://accounts.zoho.com';
  if (!/^https:\/\/accounts\.zoho\.[a-z.]+$/.test(accountsUrl)) throw new Error('--accounts must look like https://accounts.zoho.in (the client\'s Zoho data centre).');
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const code = process.env.ZOHO_CODE;
  if (!clientId || !clientSecret || !code) throw new Error('Set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_CODE first.');

  const { refreshToken, apiDomain } = await zoho.exchangeCode({ accountsUrl, clientId, clientSecret, code });
  const settings = { zohoSync: 'on', zohoAccountsUrl: accountsUrl, zohoApiDomain: apiDomain };
  if (flag(args, '--id-field')) settings.zohoIdField = flag(args, '--id-field');
  if (flag(args, '--link-field')) settings.zohoLinkField = flag(args, '--link-field');
  if (flag(args, '--lead-source')) settings.zohoLeadSource = flag(args, '--lead-source');
  if (flag(args, '--pipeline')) settings.zohoDealPipeline = flag(args, '--pipeline');
  if (flag(args, '--won-stage')) settings.zohoWonStage = flag(args, '--won-stage');
  if (flag(args, '--lost-stage')) settings.zohoLostStage = flag(args, '--lost-stage');
  await registry.update(tenant.id, { settings, secrets: { zohoClientId: clientId, zohoClientSecret: clientSecret, zohoRefreshToken: refreshToken } });
  console.log(`Zoho connected for ${tenant.slug} (API ${apiDomain || 'from token'}).`);
  return status(tenant);
}

async function status(tenant) {
  const t = registry.config(tenant.id);
  console.log(`Zoho sync for ${t.slug}: ${t.zoho.on ? 'on' : 'off'}`);
  if (!t.zoho.on) return;
  await tenancy.run(t.id, async () => {
    const org = await zoho.api('get', '/org');
    const o = org.data && org.data.org && org.data.org[0];
    console.log(`Zoho organisation: ${o ? `${o.company_name} (${o.country || 'country not set'}, currency ${o.currency || o.currency_symbol || '?'})` : 'unknown'}`);
    const rows = await db.many('SELECT status, dirty, COUNT(*)::int AS n FROM zoho_links GROUP BY status, dirty ORDER BY status');
    console.log('Leads by sync state:', rows.length ? rows.map(r => `${r.status || 'waiting'}${r.dirty ? ' (to send)' : ''}: ${r.n}`).join(', ') : 'none yet');
    const cur = await db.one('SELECT pulled_until, last_error FROM zoho_cursors');
    console.log(`Read from Zoho until: ${cur && cur.pulled_until ? new Date(cur.pulled_until).toISOString() : 'not yet'}${cur && cur.last_error ? `, last error: ${cur.last_error}` : ''}`);
    const dead = await db.many("SELECT wa_id, last_error FROM zoho_links WHERE status = 'dead' ORDER BY pushed_at DESC NULLS LAST LIMIT 5");
    for (const d of dead) console.log(`  not sent: ${d.wa_id}: ${d.last_error}`);
  });
}

async function backfill(tenant, args) {
  if (!registry.config(tenant.id).zoho.on) throw new Error('Zoho is off for this client. Run "connect" first.');
  const all = args.includes('--all');
  const days = Number(flag(args, '--days') || 30);
  if (!all && !(days > 0)) throw new Error('--days must be a positive number.');
  const n = await tenancy.run(tenant.id, async () => (await db.query(`
    INSERT INTO zoho_links (wa_id) SELECT wa_id FROM leads ${all ? '' : 'WHERE created_at > now() - ($1 || \' days\')::interval'}
    ON CONFLICT (tenant_id, wa_id) DO UPDATE SET dirty = true, dirty_at = now(), attempts = 0, next_attempt_at = NULL, status = NULL`,
  all ? [] : [String(days)])).rowCount);
  console.log(`${n} leads queued for Zoho. The running app sends them one at a time; check progress with "status".`);
}

async function off(tenant) {
  await registry.update(tenant.id, { settings: { zohoSync: 'off' } });
  console.log(`Zoho sync off for ${tenant.slug}. The connection is kept; "connect" again or set zohoSync to on to resume.`);
}

const COMMANDS = { connect, status, backfill, off };

if (require.main === module) {
  db.init()
    .then(() => tenantFromArgs())
    .then(({ tenant, args }) => {
      const cmd = COMMANDS[args[0]];
      if (!cmd) throw new Error(`Usage: npm run zoho -- [--tenant <slug>] ${Object.keys(COMMANDS).join('|')}`);
      return cmd(tenant, args.slice(1));
    })
    .then(() => db.close())
    .catch(async err => {
      console.error(err.message);
      await db.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { connect, status, backfill, off };
