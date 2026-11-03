#!/usr/bin/env node
/**
 * Sets up a new client as its own Heroku deployment of this code (until K8 multi-tenancy).
 *   cp clients/example.json clients/acme.json   # fill it in; clients/*.json is git-ignored
 *   node scripts/new-client.js clients/acme.json          # dry run: prints the steps, no secrets
 *   node scripts/new-client.js clients/acme.json --run    # does it (needs the heroku CLI, logged in)
 * Costs: a Basic dyno + Postgres essential-0 per client (about $12/month).
 */
const fs = require('fs');
const { spawnSync } = require('child_process');

const [file] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const run = process.argv.includes('--run');
if (!file) { console.error('Usage: node scripts/new-client.js clients/<client>.json [--run]'); process.exit(1); }

const c = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const k of ['clientId', 'herokuApp', 'crmHost']) {
  if (!c[k]) { console.error(`Missing "${k}" in ${file}`); process.exit(1); }
}
if (!/^[a-z0-9-]{2,30}$/.test(c.clientId)) { console.error('clientId: lowercase letters, digits and dashes only'); process.exit(1); }

const required = ['META_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'META_APP_SECRET', 'META_WEBHOOK_VERIFY_TOKEN', 'OPENROUTER_API_KEY'];
const vars = Object.fromEntries(Object.entries(c.config || {}).filter(([, v]) => v !== '' && v != null));
const missing = required.filter(k => !vars[k]);
if (missing.length) console.warn(`Warning: not set yet: ${missing.join(', ')}. The app will not start in production without them.`);

const app = c.herokuApp;
const settings = { NODE_ENV: 'production', CLIENT_ID: c.clientId, CRM_HOSTS: c.crmHost, ...vars };
const steps = [
  ['Create the app', ['apps:create', app, '--region', c.region || 'eu']],
  ['Add Postgres', ['addons:create', 'heroku-postgresql:essential-0', '-a', app]],
  ['Let the app know its own name (alerts use it)', ['labs:enable', 'runtime-dyno-metadata', '-a', app]],
  ['Set config vars', ['config:set', ...Object.entries(settings).map(([k, v]) => `${k}=${v}`), '-a', app],
    `config:set ${Object.keys(settings).join(' ')} (values hidden)`],
  ['Add the CRM domain', ['domains:add', c.crmHost, '-a', app]]
];

function heroku(args) {
  const r = spawnSync('heroku', args, { stdio: 'inherit' });
  if (r.status !== 0) { console.error('Stopped: the command above failed.'); process.exit(1); }
}

console.log(`${run ? 'Setting up' : 'Dry run for'} client "${c.clientId}" on Heroku app "${app}"\n`);
for (const [label, args, shown] of steps) {
  console.log(`- ${label}: heroku ${shown || args.join(' ')}`);
  if (run) heroku(args);
}
const push = ['push', `https://git.heroku.com/${app}.git`, 'origin/main:refs/heads/main'];
console.log(`- Deploy (runs migrations in the release phase): git ${push.join(' ')}`);
if (run) {
  const r = spawnSync('git', push, { stdio: 'inherit' });
  if (r.status !== 0) { console.error('Stopped: deploy failed.'); process.exit(1); }
}

console.log(`
Then, by hand:
1. Owner login: heroku run npm run crm:seed -a ${app} (then change the password at first login).
2. Webhook: get the URL with "heroku apps:info -a ${app}", add /webhook, and set it in the Meta app
   with the META_WEBHOOK_VERIFY_TOKEN. Subscribe the client's WABA to the app (see docs/ONBOARDING.md).
3. DNS: point ${c.crmHost} at the DNS target from "heroku domains -a ${app}".
4. CRM -> Business settings: name, business type, facts, prices. Read the prompt preview.
5. Run the test checklist in docs/ONBOARDING.md from a phone that never chatted with the number.`);
