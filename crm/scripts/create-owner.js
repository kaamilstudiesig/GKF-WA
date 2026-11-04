/**
 * Creates the first owner login for a new client, with a random one-time password.
 *   npm run crm:owner -- "Owner Name" owner@client.com
 *   On Heroku: heroku run npm run crm:owner -- "Owner Name" owner@client.com -a <app>
 * Prints the password once. The owner must change it at first login.
 * Use this, not crm:seed, on a client's deployment: the seed file's passwords are public.
 */
const crypto = require('crypto');
const { Users } = require('../src/users');

async function createOwner(db, { name, email }) {
  const users = new Users(db);
  if (await users.findByEmail(email)) return null;
  const password = crypto.randomBytes(12).toString('base64url');
  await users.create({ name, email, role: 'owner', managerId: null, password, mustChange: true });
  return password;
}

if (require.main === module) {
  const [name, email] = process.argv.slice(2);
  if (!name || !email || !email.includes('@')) {
    console.error('Usage: npm run crm:owner -- "Owner Name" owner@client.com');
    process.exit(1);
  }
  const db = require('../../src/db');
  const { migrateAll } = require('../../src/migrate');
  (async () => {
    try {
      await migrateAll();
      const password = await createOwner(db, { name, email: email.toLowerCase() });
      console.log(password
        ? `Owner created: ${email}\nOne-time password: ${password}\nShare it privately. It must be changed at first login.`
        : `A user with ${email} already exists. Nothing changed.`);
    } finally {
      await db.close();
    }
  })().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { createOwner };
