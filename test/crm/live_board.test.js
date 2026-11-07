const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { EventEmitter } = require('events');
const tenancy = require('../../src/tenancy/context');
const registry = require('../../src/tenancy/registry');
const { LiveBoard } = require('../../crm/src/liveBoard');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A fake response that records what was written. */
function fakeRes() {
  return { out: '', headers: null, writeHead(code, h) { this.code = code; this.headers = h; }, write(s) { this.out += s; }, end() { this.ended = true; } };
}

test('fan-out: only the changed client\'s boards are pinged, once per burst, with no lead data', async () => {
  let notify = null;
  const fakeDb = { listen: async (channel, fn) => { assert.strictEqual(channel, 'crm_board'); notify = fn; return async () => {}; } };
  const board = new LiveBoard(fakeDb, { debounceMs: 20, heartbeatMs: 1000 });
  const reqA = new EventEmitter(); const reqB = new EventEmitter();
  const a = fakeRes(); const b = fakeRes();
  board.subscribe(1, reqA, a);
  board.subscribe(2, reqB, b);
  await board.listening;
  assert.strictEqual(a.headers['Content-Type'], 'text/event-stream; charset=utf-8');
  assert.match(a.out, /event: ready\ndata: {"live":true}/);

  notify('{"t":1}'); notify('{"t":1}'); notify('{"t":1}'); notify('not json');
  await sleep(60);
  assert.strictEqual((a.out.match(/event: board/g) || []).length, 1);
  assert.match(a.out, /event: board\ndata: {}\n\n/);
  assert.doesNotMatch(b.out, /event: board/);

  reqA.emit('close');
  assert.strictEqual(board.viewers(1), 0);
  notify('{"t":2}');
  await sleep(60);
  assert.match(b.out, /event: board/);
  await board.stop();
  assert.ok(b.ended);

  // No listen() on the db: the stream still opens but says it isn't live.
  const quiet = new LiveBoard({});
  const c = fakeRes();
  quiet.subscribe(1, new EventEmitter(), c);
  assert.match(c.out, /"live":false/);
  await quiet.stop();
});

test('database triggers NOTIFY with the client id for changes that move a card', async () => {
  const ctx = await setup();
  const seen = [];
  const unlisten = await ctx.db.listen('crm_board', p => seen.push(JSON.parse(p).t));
  try {
    const acme = await registry.create({ slug: 'acmelive', name: 'Acme Live', phoneNumberId: '1000200030077', crmHost: 'crm.acmelive.test' });
    const waitFor = async n => { for (let i = 0; i < 50 && seen.length < n; i++) await sleep(20); };

    await ctx.db.query("INSERT INTO leads (wa_id, status) VALUES ('915500000001', 'new')");
    await waitFor(1);
    assert.deepStrictEqual(seen, [1]);

    await tenancy.run(acme.id, () => ctx.db.query("INSERT INTO leads (wa_id, status) VALUES ('915500000001', 'new')"));
    await waitFor(2);
    assert.deepStrictEqual(seen, [1, acme.id]);

    // Things that move cards: status, assignment, outcome, follow-up, hand-off.
    seen.length = 0;
    const salesId = await ctx.userId('sales');
    await ctx.db.query("UPDATE leads SET status = 'hot' WHERE wa_id = '915500000001'");
    await ctx.db.query('INSERT INTO crm_lead_assignments (wa_id, user_id) VALUES ($1, $2)', ['915500000001', salesId]);
    await ctx.db.query("INSERT INTO crm_lead_outcomes (wa_id, user_id, outcome) VALUES ('915500000001', $1, 'no_answer')", [salesId]);
    await ctx.db.query("INSERT INTO crm_follow_ups (wa_id, user_id, title, due_at) VALUES ('915500000001', $1, 'Call', now())", [salesId]);
    await ctx.db.query("INSERT INTO handoffs (wa_id, reason) VALUES ('915500000001', 'other')");
    await waitFor(5);
    assert.strictEqual(seen.length, 5);
    assert.ok(seen.every(t => t === 1));

    // A change that doesn't move a card (notes on the lead row) stays quiet.
    seen.length = 0;
    await ctx.db.query("UPDATE leads SET notes = 'x' WHERE wa_id = '915500000001'");
    await sleep(100);
    assert.deepStrictEqual(seen, []);
  } finally { await unlisten(); await ctx.cleanup(); }
});

test('/events streams to logged-in staff and pings when a lead changes; overdue cards are red', async () => {
  const ctx = await setup();
  const server = http.createServer(ctx.app).listen(0);
  try {
    const port = server.address().port;
    const owner = await login(ctx.app, 'owner');
    const cookie = owner.agent.jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false }).map(c => c.toValueString()).join('; ');

    // Not logged in: redirected to the login page, no stream.
    const anon = await new Promise(resolve => http.get({ port, path: '/events' }, resolve));
    assert.strictEqual(anon.statusCode, 302);
    anon.resume();

    const res = await new Promise(resolve => http.get({ port, path: '/events', headers: { Cookie: cookie } }, resolve));
    assert.strictEqual(res.statusCode, 200);
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => { body += d; });
    for (let i = 0; i < 50 && !/event: ready/.test(body); i++) await sleep(20);
    assert.match(body, /"live":true/);
    await ctx.app.locals.liveBoard.listening;

    await ctx.db.query("INSERT INTO leads (wa_id, status) VALUES ('915500000009', 'new')");
    for (let i = 0; i < 100 && !/event: board/.test(body); i++) await sleep(20);
    assert.match(body, /event: board\ndata: {}/);
    assert.doesNotMatch(body, /915500000009/); // no lead data in the stream
    res.destroy();

    // A lead with an overdue follow-up shows red on the board.
    const salesId = await ctx.userId('sales');
    await ctx.db.query("INSERT INTO crm_follow_ups (wa_id, user_id, title, due_at) VALUES ('915500000009', $1, 'Call back', now() - interval '1 hour')", [salesId]);
    const page = (await owner.agent.get('/pipeline')).text;
    const card = page.slice(page.indexOf('data-wa="915500000009"') - 200, page.indexOf('data-wa="915500000009"') + 1500);
    assert.match(card, /border-error/);
    assert.match(card, /data-overdue >Follow-up overdue/);
    assert.match(page, /data-live hidden/);
  } finally {
    server.close();
    await ctx.app.locals.liveBoard.stop();
    await ctx.cleanup();
  }
});

test('pings to one client are spaced out, and a change in the gap still arrives at the end', async () => {
  let notify = null;
  const board = new LiveBoard({ listen: async (c, fn) => { notify = fn; return async () => {}; } }, { debounceMs: 20, minIntervalMs: 200, heartbeatMs: 1000 });
  const res = fakeRes();
  board.subscribe(1, new EventEmitter(), res);
  await board.listening;
  const pings = () => (res.out.match(/event: board/g) || []).length;

  notify('{"t":1}');
  await sleep(60);
  assert.strictEqual(pings(), 1); // first change: after the short debounce
  for (let i = 0; i < 5; i++) { notify('{"t":1}'); await sleep(10); } // busy period
  await sleep(60);
  assert.strictEqual(pings(), 1); // still inside the 200 ms gap: no new ping yet
  await sleep(150);
  assert.strictEqual(pings(), 2); // one trailing ping for all of them
  await sleep(300);
  assert.strictEqual(pings(), 2); // nothing changed since: nothing more
  await board.stop();
});
