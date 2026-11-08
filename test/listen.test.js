require('./helpers'); // test env before anything from src/ loads
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { listenLoop } = require('../src/db');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A fake pg Client. `plan` says, per client created, whether connect() fails. */
function fakeClients(plan) {
  const made = [];
  const make = () => {
    const c = new EventEmitter();
    const fail = plan[made.length] === 'fail';
    c.queries = [];
    c.connect = async () => { if (fail) throw new Error('database down'); };
    c.query = async sql => { c.queries.push(sql); };
    c.end = async () => { c.ended = true; };
    made.push(c);
    return c;
  };
  return { make, made };
}

test('LISTEN refreshes boards on every successful connect: after a failed start, and after a drop', async () => {
  const { make, made } = fakeClients(['fail', 'ok', 'ok']);
  const payloads = [];
  let refreshes = 0;
  const stop = listenLoop(make, 'crm_board', p => payloads.push(p), { onReconnect: () => refreshes++, minDelayMs: 5, maxDelayMs: 20 });

  await sleep(40); // first connect fails, the retry works
  assert.strictEqual(made.length, 2);
  assert.deepStrictEqual(made[1].queries, ['LISTEN crm_board']);
  assert.strictEqual(refreshes, 1); // the board opened during the outage still gets a refresh

  made[1].emit('notification', { channel: 'crm_board', payload: '{"t":1}' });
  made[1].emit('notification', { channel: 'other', payload: 'x' });
  assert.deepStrictEqual(payloads, ['{"t":1}']);

  made[1].emit('error', new Error('connection reset')); // the database restarts
  await sleep(40);
  assert.strictEqual(made.length, 3);
  assert.ok(made[1].ended);
  assert.strictEqual(refreshes, 2); // and once more after the reconnect

  await stop();
  assert.ok(made[2].ended);
  made[2].emit('end');
  await sleep(30);
  assert.strictEqual(made.length, 3); // stopped: no new connection
});
