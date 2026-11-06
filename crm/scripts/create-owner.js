/**
 * Creates the first owner login for a client, with a random one-time password.
 *   npm run crm:owner -- --tenant acme "Owner Name" owner@client.com
 *   On Heroku: heroku run npm run crm:owner -- --tenant acme "Owner Name" owner@client.com -a <app>
 * --tenant may be left out while there is only one tenant.
 * Prints the password once. The owner must change it at first login.
 * Use this, not crm:seed, on a client's deployment: the seed file's passwords are public.
 */
const { Users } = require('../src/users');
const { oneTimePassword } = require('../src/auth');

async function createOwner(db, { name, email }) {
  const users = new Users(db);
  if (await users.findByEmail(email)) return null;
  const password = oneTimePassword();
  await users.create({ name, email, role: 'owner', managerId: null, password, mustChange: true });
  return password;
}

if (require.main === module) {
  const db = require('../../src/db');
  const { migrateAll } = require('../../src/migrate');
  const tenancy = require('../../src/tenancy/context');
  const { tenantFromArgs } = require('../../scripts/lib/tenantArg');
  (async () => {
    try {
      await migrateAll();
      const { tenant, args } = await tenantFromArgs();
      const [name, email] = args;
      if (!name || !email || !email.includes('@')) {
        throw new Error('Usage: npm run crm:owner -- --tenant <slug> "Owner Name" owner@client.com');
      }
      const password = await tenancy.run(tenant.id, () => createOwner(db, { name, email: email.toLowerCase() }));
      console.log(password
        ? `Owner created for ${tenant.name} (${tenant.slug}): ${email}\nOne-time password: ${password}\nShare it privately. It must be changed at first login.`
        : `A user with ${email} already exists for ${tenant.slug}. Nothing changed.`);
    } finally {
      await db.close();
    }
  })().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { createOwner };
