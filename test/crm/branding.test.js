const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const gymConfig = require('../../src/config/gymConfig');
const { initials, normalizeColor, contentColor, nameParts, slug, parseLogo } = require('../../crm/src/branding');

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const pngUrl = `data:image/png;base64,${PNG.toString('base64')}`;

test('branding helpers', () => {
  assert.strictEqual(initials('Sunrise Dental Clinic'), 'SD');
  assert.strictEqual(initials('Acme'), 'AC');
  assert.strictEqual(initials('  '), 'CR');
  assert.strictEqual(normalizeColor('#ABC'), '#aabbcc');
  assert.strictEqual(normalizeColor('1e40af'), '#1e40af');
  assert.strictEqual(normalizeColor('red'), null);
  assert.strictEqual(normalizeColor('#12345g'), null);
  assert.strictEqual(contentColor('#ffd34d'), '#141414'); // light colour -> dark text
  assert.strictEqual(contentColor('#1e3a8a'), '#ffffff'); // dark colour -> white text
  assert.deepStrictEqual(nameParts('Sunrise Dental Clinic'), { first: 'Sunrise Dental', last: 'Clinic' });
  assert.deepStrictEqual(nameParts('Acme'), { first: 'Acme', last: '' });
  assert.strictEqual(slug('Sunrise Dental & Co.'), 'sunrise-dental-co');
  assert.strictEqual(parseLogo(pngUrl).type, 'image/png');
  assert.throws(() => parseLogo('data:image/svg+xml;base64,PHN2Zy8+'), /PNG, JPEG or WebP/);
  assert.throws(() => parseLogo(`data:image/jpeg;base64,${PNG.toString('base64')}`), /PNG, JPEG or WebP/); // type must match the bytes
  const big = Buffer.concat([PNG, Buffer.alloc(41 * 1024)]);
  assert.throws(() => parseLogo(`data:image/png;base64,${big.toString('base64')}`), /too big/);
});

test('no business name is hard-coded in the CRM views', () => {
  const dir = path.join(__dirname, '..', '..', 'crm', 'views');
  const files = fs.readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.ejs'));
  for (const f of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, f), 'utf8'), /goldkraft|gkf/i, f);
  }
});

test('pages show the business name from the profile', async () => {
  const ctx = await setup();
  try {
    gymConfig.setProfile({ ...gymConfig.DEFAULT_PROFILE, name: 'Sunrise Dental Clinic' });
    const loginPage = await request(ctx.app).get('/login');
    assert.match(loginPage.text, /<title>Sign in · Sunrise Dental Clinic<\/title>/);
    assert.match(loginPage.text, /Sunrise Dental <span class="text-primary">Clinic<\/span>/);
    assert.match(loginPage.text, /for the Sunrise Dental Clinic team/);
    assert.match(loginPage.text, />SD<\/span>/); // default logo letters
    assert.match(loginPage.text, /data-theme="brand">/); // default colour: no inline override
    const owner = await login(ctx.app, 'owner');
    assert.match((await owner.agent.get('/')).text, /All of Sunrise Dental Clinic/);
    const csv = await owner.agent.get('/reports/leads.csv');
    assert.match(csv.headers['content-disposition'], /filename="sunrise-dental-clinic-leads-\d{4}-\d{2}-\d{2}\.csv"/);
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

test('owner sets logo letters, colour and logo; others cannot', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    const settings = await owner.agent.get('/settings');
    assert.match(settings.text, /action="\/settings\/brand"/);

    const r = await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, mark: 'gk', color: '#1e3a8a', logo: '' });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.location, /^\/settings\?ok=Branding/);
    let page = (await owner.agent.get('/')).text;
    assert.match(page, />GK<\/span>/);
    assert.match(page, /style="--color-primary:#1e3a8a;--color-primary-content:#ffffff"/);
    assert.doesNotMatch(page, /\/brand\/logo/);

    // Upload a logo: every page uses the image, and it is served publicly with its type.
    await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, mark: 'GK', color: '#1e3a8a', logo: pngUrl });
    page = (await request(ctx.app).get('/login')).text;
    const src = /<img src="(\/brand\/logo\?v=[0-9a-f]+)"/.exec(page);
    assert.ok(src, 'login page shows the logo');
    const img = await request(ctx.app).get(src[1].replace(/&amp;/g, '&'));
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers['content-type'], 'image/png');
    assert.ok(Buffer.compare(img.body, PNG) === 0);

    // Saving without a new file keeps the logo; remove_logo deletes it.
    await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, mark: 'GK', color: '#1e3a8a', logo: '' });
    assert.strictEqual((await request(ctx.app).get('/brand/logo')).status, 200);
    await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, mark: '', color: '#d4af37', remove_logo: '1' });
    assert.strictEqual((await request(ctx.app).get('/brand/logo')).status, 404);
    page = (await owner.agent.get('/')).text;
    assert.match(page, /data-theme="brand">/); // back to the default look

    // Bad input is refused with a message and nothing changes.
    const bad = await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, mark: '<b>', color: '#1e3a8a' });
    assert.strictEqual(bad.status, 400);
    assert.match(bad.text, /Logo letters/);
    const badColor = await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, mark: '', color: 'blue' });
    assert.strictEqual(badColor.status, 400);
    const svg = await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, color: '#1e3a8a', logo: 'data:image/svg+xml;base64,PHN2Zy8+' });
    assert.strictEqual(svg.status, 400);

    const manager = await login(ctx.app, 'manager');
    const denied = await manager.agent.post('/settings/brand').type('form').send({ _csrf: manager.csrf, mark: 'X', color: '#000000' });
    assert.strictEqual(denied.status, 403);
    const row = await ctx.db.one('SELECT mark, color FROM crm_branding');
    assert.deepStrictEqual(row, { mark: null, color: '#d4af37' });
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});
