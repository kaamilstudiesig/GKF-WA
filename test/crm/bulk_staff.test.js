const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const { parseCsv, rowsFromForm, parseRole } = require('../../crm/src/bulkStaff');
const { verifyPassword, validateNewPassword } = require('../../crm/src/auth');

test('CSV parsing: header, quotes, tabs, blank lines', () => {
  const rows = parseCsv('Name,Email,Role,Manager email,WhatsApp\n"Rao, Asha",asha@x.com,Manager\n\nVik,vik@x.com,,asha@x.com,+91 98450 12345\n');
  assert.deepStrictEqual(rows, [
    { name: 'Rao, Asha', email: 'asha@x.com', role: 'Manager', manager: '', phone: '' },
    { name: 'Vik', email: 'vik@x.com', role: '', manager: 'asha@x.com', phone: '+91 98450 12345' }
  ]);
  assert.deepStrictEqual(parseCsv('A\ta@x.com\tsales').map(r => r.email), ['a@x.com']); // pasted from a spreadsheet
  assert.deepStrictEqual(parseCsv(''), []);
  assert.strictEqual(parseRole(''), 'sales');
  assert.strictEqual(parseRole('Sales rep'), 'sales');
  assert.strictEqual(parseRole('OWNER'), 'owner');
  assert.strictEqual(parseRole('boss'), null);
});

test('form rows: empty rows are skipped even though the role dropdown sends a value', () => {
  const rows = rowsFromForm({
    row_name: ['A', '', ''], row_email: ['a@x.com', '', ''], row_role: ['sales', 'sales', 'manager'],
    row_manager: ['', '', ''], row_phone: ['', '', ''], csv: 'B,b@x.com'
  });
  assert.deepStrictEqual(rows.map(r => r.email), ['a@x.com', 'b@x.com']);
});

function csvFor(n, managerEmail) {
  const lines = ['name,email,role,manager email,whatsapp', `Team Lead,lead@client.com,manager`];
  for (let i = 1; i <= n; i++) lines.push(`Rep ${i},rep${i}@client.com,sales,${managerEmail},${i === 1 ? '+91 98450 00001' : ''}`);
  return lines.join('\n');
}

test('owner adds 20 staff in one go and sees each one-time password once', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const page = await owner.agent.get('/users/bulk');
    assert.strictEqual(page.status, 200);
    assert.match((await owner.agent.get('/users')).text, /href="\/users\/bulk"/);

    const r = await owner.agent.post('/users/bulk').type('form').send({ _csrf: owner.csrf, csv: csvFor(19, 'lead@client.com') });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.match(r.text, /Added 20 people/);
    assert.match(r.text, /download="staff-one-time-passwords.csv"/);

    const users = await ctx.db.many("SELECT * FROM crm_users WHERE email LIKE '%@client.com' ORDER BY id");
    assert.strictEqual(users.length, 20);
    const lead = users.find(u => u.email === 'lead@client.com');
    assert.strictEqual(lead.role, 'manager');
    for (const u of users.filter(x => x.role === 'sales')) assert.strictEqual(u.manager_id, lead.id); // manager from the same list
    assert.ok(users.every(u => u.must_change_password && u.active));
    const rep1 = users.find(u => u.email === 'rep1@client.com');
    assert.deepStrictEqual([rep1.alert_phone, rep1.alert_mode], ['919845000001', 'mine']);
    assert.strictEqual(users.find(u => u.email === 'rep2@client.com').alert_mode, 'off');

    // The password shown on the page is the one that works, and meets the password rules.
    const shown = new RegExp('rep5@client.com[\\s\\S]*?<code[^>]*>([^<]+)</code>').exec(r.text)[1];
    assert.strictEqual(validateNewPassword(shown), null);
    assert.ok(verifyPassword(shown, users.find(u => u.email === 'rep5@client.com').password_hash));
    const log = await ctx.db.one("SELECT details FROM crm_activity_log WHERE action = 'staff_bulk_added'");
    assert.strictEqual(log.details.count, 20);
  } finally { await ctx.cleanup(); }
});

test('one bad row: nobody is added and each problem shows on its row', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const before = (await ctx.db.one('SELECT COUNT(*)::int AS n FROM crm_users')).n;
    const existing = (await ctx.db.one("SELECT email FROM crm_users WHERE role = 'sales' LIMIT 1")).email;
    const csv = [
      'Good One,good@client.com,sales',
      `Taken,${existing},sales`,
      'No Email,not-an-email,sales',
      'Twice,twice@client.com,sales',
      'Twice Again,TWICE@client.com,sales',
      'Bad Role,role@client.com,boss',
      'Bad Manager,bm@client.com,sales,nobody@client.com',
      'Manager With Manager,mm@client.com,manager,good@client.com',
      'Bad Phone,phone@client.com,sales,,12345'
    ].join('\n');
    const r = await owner.agent.post('/users/bulk').type('form').send({ _csrf: owner.csrf, csv });
    assert.strictEqual(r.status, 400);
    assert.match(r.text, /8 of 9 rows need fixing. Nobody was added./);
    for (const msg of ['already has an account', 'Email is not valid', 'in the list more than once', 'Role must be owner, manager or sales',
      'not an active manager', 'Only sales staff have a manager', 'needs the country code']) {
      assert.ok(r.text.includes(msg), msg);
    }
    // The pasted rows come back as editable rows, with the unknown role kept and not turned into a real role.
    assert.match(r.text, /value="good@client.com"/);
    assert.match(r.text, /<option value="boss" selected>Choose a role<\/option>/);
    assert.strictEqual((await ctx.db.one('SELECT COUNT(*)::int AS n FROM crm_users')).n, before);

    const empty = await owner.agent.post('/users/bulk').type('form').send({ _csrf: owner.csrf, csv: '' });
    assert.strictEqual(empty.status, 400);
    assert.match(empty.text, /Add at least one person/);
    const many = Array.from({ length: 101 }, (_, i) => `P${i},p${i}@client.com`).join('\n');
    assert.match((await owner.agent.post('/users/bulk').type('form').send({ _csrf: owner.csrf, csv: many })).text, /at most 100 people/);
  } finally { await ctx.cleanup(); }
});

test('only the owner can add staff in bulk', async () => {
  const ctx = await setup();
  try {
    for (const role of ['manager', 'sales']) {
      const u = await login(ctx.app, role);
      assert.strictEqual((await u.agent.get('/users/bulk')).status, 403);
      assert.strictEqual((await u.agent.post('/users/bulk').type('form').send({ _csrf: u.csrf, csv: 'X,x@client.com' })).status, 403);
    }
    assert.strictEqual((await ctx.db.one("SELECT COUNT(*)::int AS n FROM crm_users WHERE email = 'x@client.com'")).n, 0);
  } finally { await ctx.cleanup(); }
});
