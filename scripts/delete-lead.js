#!/usr/bin/env node
/**
 * Deletes everything we hold about one lead (privacy / data deletion request).
 *   npm run delete-lead -- <lead key>            # dry run: shows what would be deleted
 *   npm run delete-lead -- <lead key> --confirm  # deletes
 * On Heroku: heroku run "npm run delete-lead -- 9198xxxxxxx --confirm" -a gkf-wa
 * The lead key is the wa_id shown in the CRM URL (/leads/<key>): a phone number or a WhatsApp user ID.
 * Backups roll over within 30 days.
 */
const db = require('../src/db');

// The deletion itself is shared with K31 automatic deletion.
const { deleteLead } = require('../src/services/leadDeletion');

if (require.main === module) {
  const tenancy = require('../src/tenancy/context');
  const { tenantFromArgs } = require('./lib/tenantArg');
  db.init()
    .then(() => tenantFromArgs())
    .then(({ tenant, args }) => {
      const [key, flag] = args;
      if (!key) throw new Error('Usage: npm run delete-lead -- [--tenant <slug>] <lead key> [--confirm]');
      return tenancy.run(tenant.id, () => deleteLead(key, { confirm: flag === '--confirm' }))
        .then(r => ({ ...r, key }));
    })
    .then(r => {
      const key = r.key;
      if (!r.found) console.log(`No lead with key ${key}.`);
      else if (!r.deleted) console.log(`Dry run. Would delete lead ${key} and:`, r.counts, '\nRun again with --confirm to delete.');
      else console.log(`Deleted lead ${key} and:`, r.counts);
    })
    .catch(err => { console.error(err.message); process.exitCode = 1; })
    .finally(() => db.close());
}

module.exports = { deleteLead };
