const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const gymConfig = require('../../src/config/gymConfig');
const { iconSvg, pngSize, manifest } = require('../../crm/src/pwa');

// 1x1 PNG, and the same header claiming 192x192 for the size check.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

test('pwa helpers: icon, PNG size, short name', () => {
  const brand = { name: 'Sunrise Dental Clinic', first: 'Sunrise Dental', mark: 'S&D', color: '#1e3a8a', contentColor: '#ffffff', logoUrl: null };
  const svg = iconSvg(brand);
  assert.match(svg, /fill="#1e3a8a"/);
  assert.match(svg, />S&amp;D<\/text>/); // escaped
  assert.match(svg, /rx="96"/);
  assert.match(iconSvg(brand, { pad: true }), /rx="0"/); // maskable: Android adds its own shape
  assert.deepStrictEqual(pngSize(PNG), { width: 1, height: 1 });
  assert.strictEqual(pngSize(Buffer.from('not a png at all, really not')), null);
  assert.strictEqual(manifest(brand).short_name, 'S&D'); // both name and first part are too long
  assert.strictEqual(manifest({ ...brand, name: 'Acme Realty', first: 'Acme' }).short_name, 'Acme Realty');
});

test('manifest, icon, service worker and offline page are public and per client', async () => {
  const ctx = await setup();
  try {
    gymConfig.setProfile({ ...gymConfig.DEFAULT_PROFILE, name: 'Sunrise Dental Clinic' });
    const app = request(ctx.app);

    const loginPage = await app.get('/login');
    assert.match(loginPage.text, /<link rel="manifest" href="\/manifest.webmanifest">/);
    assert.match(loginPage.text, /apple-mobile-web-app-capable/);
    // No logo yet: iPhones get a PNG tile in the brand colour (they ignore SVG icons).
    assert.match(loginPage.text, /<link rel="apple-touch-icon" href="\/brand\/apple-touch-icon.png">/);
    const tile = await app.get('/brand/apple-touch-icon.png').buffer(true).parse((res, cb) => { const b = []; res.on('data', d => b.push(d)); res.on('end', () => cb(null, Buffer.concat(b))); });
    assert.strictEqual(tile.headers['content-type'], 'image/png');
    assert.deepStrictEqual(pngSize(tile.body), { width: 180, height: 180 });

    const m = await app.get('/manifest.webmanifest');
    assert.strictEqual(m.status, 200);
    assert.match(m.headers['content-type'], /application\/manifest\+json/);
    const json = JSON.parse(m.text);
    assert.strictEqual(json.name, 'Sunrise Dental Clinic');
    assert.deepStrictEqual([json.start_url, json.scope, json.display], ['/', '/', 'standalone']);
    assert.ok(json.icons.some(i => i.src === '/brand/icon.svg' && i.purpose === 'any'));
    assert.ok(json.icons.some(i => i.purpose === 'maskable'));
    assert.ok(json.shortcuts.length >= 2);

    const icon = await app.get('/brand/icon.svg');
    assert.strictEqual(icon.status, 200);
    assert.match(icon.headers['content-type'], /image\/svg\+xml/);
    assert.match(icon.body.toString(), />SD<\/text>/);

    const sw = await app.get('/sw.js');
    assert.strictEqual(sw.status, 200);
    assert.match(sw.headers['content-type'], /javascript/);
    assert.strictEqual(sw.headers['cache-control'], 'no-cache');
    assert.doesNotMatch(sw.text, /__ASSET_VERSION__/);
    assert.match(sw.text, /const VERSION = '[0-9a-f]{10}'/);
    assert.doesNotMatch(sw.text, /cache\.put|caches\.open\(CACHE\)\.then\(c => c\.put/); // never stores pages

    const ownerForHint = await login(ctx.app, 'owner');
    assert.match((await ownerForHint.agent.get('/settings')).text, /For the app icon on iPhones, upload a square PNG/);

    const offline = await app.get('/offline');
    assert.strictEqual(offline.status, 200);
    assert.match(offline.text, /You're offline/);
    assert.doesNotMatch(offline.text, /_csrf/); // cached by the service worker: must hold nothing private

    // An uploaded square PNG logo is offered as an icon too.
    const owner = await login(ctx.app, 'owner');
    await owner.agent.post('/settings/brand').type('form').send({ _csrf: owner.csrf, mark: '', color: '#d4af37', logo: `data:image/png;base64,${PNG.toString('base64')}` });
    const withLogo = JSON.parse((await app.get('/manifest.webmanifest')).text);
    assert.deepStrictEqual(withLogo.icons[0].sizes, '1x1');
    assert.match(withLogo.icons[0].src, /^\/brand\/logo\?v=/);
    assert.match((await app.get('/login')).text, /<link rel="apple-touch-icon" href="\/brand\/logo\?v=/);
  } finally { await ctx.cleanup(); gymConfig.resetToDefault(); }
});

test('menu has the install button and the iPhone hint (hidden until the browser offers it)', async () => {
  const ctx = await setup();
  try {
    const sales = await login(ctx.app, 'sales');
    const page = (await sales.agent.get('/')).text;
    assert.match(page, /data-install hidden/);
    assert.match(page, /data-ios-install hidden/);
  } finally { await ctx.cleanup(); }
});
