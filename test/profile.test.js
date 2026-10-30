const { db, converse, reset } = require('./helpers');
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../src/config/gymConfig');
const businessProfile = require('../src/services/businessProfile');
const router = require('../src/services/deterministicRouter');

after(() => db.close());
beforeEach(async () => { await reset(); await db.query('DELETE FROM business_profile'); gymConfig.resetToDefault(); });

const edited = () => ({
  ...gymConfig.DEFAULT_PROFILE,
  name: 'Iron Temple',
  area: 'Indiranagar, Bengaluru',
  hours: ['Every day 6 AM - 11 PM'],
  plans: [{ name: 'Monthly', price: '₹2,999/month', details: 'Full access' }, { name: 'Yearly', price: '₹24,000/year', details: '' }],
  latitude: 12.97, longitude: 77.64
});

test('the first load saves the defaults, so nothing changes for GKF', async () => {
  await businessProfile.load();
  const row = await db.one('SELECT profile, updated_by FROM business_profile WHERE id = 1');
  assert.strictEqual(row.profile.name, 'Goldkraft Fitness');
  assert.strictEqual(row.updated_by, 'defaults');
  assert.match(gymConfig.getSystemPrompt(), /Monthly: ₹4,040\/month/);
});

test('a saved profile drives the prompt, fixed answers and map pin', async () => {
  await businessProfile.save(edited(), 'owner@example.test');
  gymConfig.resetToDefault();
  await businessProfile.load(); // as another process would
  const prompt = gymConfig.getSystemPrompt();
  assert.match(prompt, /front desk of Iron Temple, a gym in Indiranagar/);
  assert.match(prompt, /Timings: Every day 6 AM - 11 PM\./);
  assert.match(prompt, /"reply":"Monthly is ₹2,999\/month\. Yearly is ₹24,000\/year/); // examples quote saved prices
  assert.doesNotMatch(prompt, /4,040/);
  assert.match(router.routeMessage('gym timings').replyText, /• Every day 6 AM - 11 PM/);
  assert.match(router.routeMessage('what are your prices').replyText, /Monthly: ₹2,999\/month/);
  assert.deepStrictEqual(router.routeMessage('where is the gym located?').location,
    { latitude: 12.97, longitude: 77.64, name: 'Iron Temple', address: gymConfig.DEFAULT_PROFILE.address });
});

test('the bot replies with the saved details end to end', async () => {
  await businessProfile.save(edited());
  await converse('919866600001', 'what are your timings?');
  const out = await db.one(`SELECT text FROM messages WHERE wa_id = '919866600001' AND direction = 'out'`);
  assert.match(out.text, /Iron Temple timings/);
});

test('bad profiles are rejected with a clear message and nothing changes', async () => {
  const cases = [
    [{ ...edited(), name: ' ' }, /name is required/],
    [{ ...edited(), plans: [{ name: 'Monthly', price: '' }] }, /at least one plan/],
    [{ ...edited(), hours: [] }, /opening hours/],
    [{ ...edited(), latitude: 12.9, longitude: '' }, /both latitude and longitude/]
  ];
  for (const [input, msg] of cases) {
    await assert.rejects(businessProfile.save(input), err => err instanceof businessProfile.ProfileError && msg.test(err.message));
  }
  assert.strictEqual(gymConfig.gymName, 'Goldkraft Fitness');
});

test('text is cleaned and lists are capped', () => {
  const p = businessProfile.normalize({ ...edited(), hours: 'Mon-Fri 6-10\n\n  Sat 7-1  \n', programs: Array(30).fill('X'), type: 'spaceship' });
  assert.deepStrictEqual(p.hours, ['Mon-Fri 6-10', 'Sat 7-1']);
  assert.strictEqual(p.programs.length, businessProfile.LIMITS.programs);
  assert.strictEqual(p.type, 'gym');
});
