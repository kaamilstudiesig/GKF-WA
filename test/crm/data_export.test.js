const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const tenancy = require('../../src/tenancy/context');
const registry = require('../../src/tenancy/registry');
const { makeZip, readZip } = require('../../crm/src/zip');
const { toCsv, csvCell } = require('../../crm/src/csv');
const { FILES } = require('../../crm/src/dataExport');

const LEAD = '919845012345'; // Rahul in the demo data

// Downloads the export as a Buffer (supertest buffers binary bodies with a custom parser).
const download = agent => agent.get('/settings/export.zip').buffer(true).parse((res, cb) => {
  const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks)));
});
const filesOf = buf => Object.fromEntries(readZip(buf).map(f => [f.name, f.data.toString('utf8')]));

test('R19 zip: files round-trip, UTF-8 names and text, CRC checked', () => {
  const zip = makeZip([{ name: 'a.csv', data: 'x,y\r\n1,2\r\n' }, { name: 'نص.txt', data: 'مرحبا ₹ नमस्ते' }]);
  assert.strictEqual(zip.readUInt32LE(0), 0x04034b50);
  const files = readZip(zip);
  assert.deepStrictEqual(files.map(f => [f.name, f.data.toString('utf8')]), [['a.csv', 'x,y\r\n1,2\r\n'], ['نص.txt', 'مرحبا ₹ नमस्ते']]);
  zip[40] ^= 0xff; // corrupt the first file's data
  assert.throws(() => readZip(zip));
});

test('R19 csv: quoting, JSON, dates, formula guard, BOM', () => {
  assert.strictEqual(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.strictEqual(csvCell({ a: 1 }), '"{""a"":1}"');
  assert.strictEqual(csvCell(new Date('2030-01-02T03:04:05Z')), '2030-01-02T03:04:05.000Z');
  assert.strictEqual(csvCell(null), '');
  assert.strictEqual(toCsv(['a'], [{ a: 'x' }], { bom: true }), '﻿a\r\nx\r\n');
});

test('R19 owner downloads every table as CSV in one ZIP; logged; no secrets', async () => {
  const ctx = await setup();
  try {
    const db = ctx.db;
    const salesId = await ctx.userId('sales');
    await db.query("INSERT INTO crm_lead_notes (wa_id, user_id, body) VALUES ($1, $2, '=cmd|calc, \"quoted\"\nsecond line')", [LEAD, salesId]);
    await db.query("INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome, plan, amount_inr) VALUES ($1, $2, 'joined', 'Monthly', 7080)", [LEAD, salesId]);
    await db.query("INSERT INTO messages (wa_id, direction, text, timestamp) VALUES ($1, 'in', 'مرحبا, price kya hai?', now())", [LEAD]);

    const owner = await login(ctx.app, 'owner');
    const res = await download(owner.agent);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /attachment; filename=".+-data-\d{4}-\d{2}-\d{2}\.zip"/);
    assert.strictEqual(res.headers['cache-control'], 'no-store');

    const files = filesOf(res.body);
    assert.deepStrictEqual(Object.keys(files), ['README.txt', ...FILES.map(f => f.name)]);
    for (const f of FILES) assert.ok(files[f.name].startsWith('﻿' + f.columns.join(',') + '\r\n'), f.name); // BOM + header

    const leadsCount = (await db.one('SELECT COUNT(*)::int AS c FROM leads')).c;
    assert.strictEqual(files['leads.csv'].trim().split('\r\n').length, leadsCount + 1);
    assert.match(files['leads.csv'], new RegExp(`\\r\\n${LEAD},`));
    assert.match(files['messages.csv'], /مرحبا, price kya hai\?/);
    assert.match(files['outcomes.csv'], /,joined,Monthly,7080,/);
    assert.match(files['notes.csv'], /"'=cmd\|calc, ""quoted""\nsecond line"/); // formula made inert, quotes and new line kept
    assert.match(files['README.txt'], /Amounts are whole units of INR\./);
    assert.match(files['README.txt'], new RegExp(`leads\\.csv \\(${leadsCount}\\)`));

    // No password hashes, sessions or tokens anywhere.
    const hashes = (await db.many('SELECT password_hash FROM crm_users')).map(r => r.password_hash);
    const all = Object.values(files).join('\n');
    for (const h of hashes) assert.ok(!all.includes(h), 'password hash leaked');
    assert.doesNotMatch(files['staff.csv'].split('\r\n')[0], /password|token/i);

    const log = await db.one("SELECT user_id, details FROM crm_activity_log WHERE action = 'data_exported' ORDER BY id DESC LIMIT 1");
    assert.strictEqual(log.user_id, await ctx.userId('owner'));
    assert.strictEqual(log.details.files['leads.csv'], leadsCount);

    // Business settings links to it.
    assert.match((await owner.agent.get('/settings')).text, /href="\/settings\/export\.zip"/);
  } finally { await ctx.cleanup(); }
});

test('R19 only owners can export', async () => {
  const ctx = await setup();
  try {
    for (const role of ['manager', 'sales']) {
      const u = await login(ctx.app, role);
      assert.strictEqual((await u.agent.get('/settings/export.zip')).status, 403, role);
    }
    assert.strictEqual((await ctx.db.one("SELECT COUNT(*)::int AS c FROM crm_activity_log WHERE action = 'data_exported'")).c, 0);
  } finally { await ctx.cleanup(); }
});

test('R19 one client\'s export never contains another client\'s data', async () => {
  const ctx = await setup();
  try {
    const acme = await registry.create({ slug: 'acmex', name: 'Acme X', phoneNumberId: '1000200030077', crmHost: 'crm.acmex.test' });
    await tenancy.run(acme.id, async () => {
      await ctx.db.query("INSERT INTO leads (wa_id, display_name, status) VALUES ('916600000077', 'Acme Only Lead', 'hot')");
      await ctx.db.query("INSERT INTO messages (wa_id, direction, text, timestamp) VALUES ('916600000077', 'in', 'acme secret message', now())");
    });
    const owner = await login(ctx.app, 'owner');
    const files = filesOf((await download(owner.agent)).body);
    const all = Object.values(files).join('\n');
    assert.ok(!all.includes('Acme Only Lead') && !all.includes('acme secret message') && !all.includes('916600000077'));
  } finally { await ctx.cleanup(); }
});
