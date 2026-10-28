/**
 * Creates the starting staff accounts from SEED_USERS_FILE (default
 * seed/users.example.json). Existing emails are left untouched, so this is
 * safe to run more than once.
 */
const fs = require('fs');
const config = require('../src/config');
const { createDb } = require('../src/db');
const { migrateCrm } = require('../src/migrations');
const { Users } = require('../src/users');

async function seedUsers(db, file) {
  const { users: list } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const users = new Users(db);
  const created = [];
  // Managers first so sales reps can reference them.
  const order = { owner: 0, manager: 1, sales: 2 };
  for (const u of [...list].sort((a, b) => order[a.role] - order[b.role])) {
    if (await users.findByEmail(u.email)) continue;
    const manager = u.manager_email ? await users.findByEmail(u.manager_email) : null;
    await users.create({ name: u.name, email: u.email, role: u.role, managerId: manager ? manager.id : null, password: u.password, mustChange: true });
    created.push(`${u.role}: ${u.email}`);
  }
  return created;
}

if (require.main === module) {
  (async () => {
    const db = createDb(config.databaseUrl());
    try {
      await migrateCrm(db);
      const created = await seedUsers(db, config.seedUsersFile);
      console.log(created.length ? `Created users:\n  ${created.join('\n  ')}` : 'All seed users already exist.');
      console.log(`Passwords are in ${config.seedUsersFile}. Each user must change theirs at first login.`);
    } finally {
      await db.close();
    }
  })().catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { seedUsers };
