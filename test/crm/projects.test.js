const { setup, login } = require('./helpers');
const test = require('node:test');
const assert = require('node:assert');
const gymConfig = require('../../src/config/gymConfig');
const registry = require('../../src/tenancy/registry');
const tenancy = require('../../src/tenancy/context');
const { Projects, catalogNeeds, SEND_LIMITS } = require('../../crm/src/projects');

const LEAD = '919845012345'; // Rahul in the demo data: wrote an hour ago, reply window open
const asDubai = () => gymConfig.setProfile({ ...gymConfig.DEFAULT_PROFILE, type: 'realestate', currency: 'AED' });

test('R17 projects and units: add, edit, retailer id, sold out, archive, reorder', async () => {
  const ctx = await setup();
  try {
    const p = new Projects(ctx.db);
    const palm = await p.addProject({ name: 'Palm Crest', area: 'Dubai Hills', kind: 'Apartments', handover: 'Q4 2027', brochure_url: 'https://example.com/palm.pdf' });
    const marina = await p.addProject({ name: 'Marina Vista' });
    const two = await p.addUnit(palm.id, { name: '2 Bedroom', size_sqft: '1,250', price_from: 'AED 1,800,000' });
    const studio = await p.addUnit(palm.id, { name: 'Studio', price_from: '750000' });
    assert.strictEqual(two.retailer_id, `u${two.id}`); // generated, never typed
    assert.deepStrictEqual([two.size_sqft, two.price_from, two.dirty], [1250, 1800000, true]);

    // Bad input is refused with a message.
    await assert.rejects(p.addProject({ name: '' }), /Give the project a name/);
    await assert.rejects(p.addProject({ name: 'X', brochure_url: 'http://insecure.example' }), /https/);
    await assert.rejects(p.addUnit(palm.id, { name: '1BR', price_from: '1.5M' }), /Price from/);

    // Editing keeps the retailer id; the catalog will need the unit again (K24).
    await ctx.db.query('UPDATE crm_units SET dirty = false');
    const renamed = await p.updateUnit(two.id, { name: '2 Bedroom + maid', price_from: '1900000' });
    assert.deepStrictEqual([renamed.retailer_id, renamed.dirty, renamed.price_from], [`u${two.id}`, true, 1900000]);

    // Sold out, archive: archived disappears from the list, not from the database.
    await p.setStatus('unit', studio.id, 'sold_out');
    await p.setStatus('project', marina.id, 'archived');
    let list = await p.list();
    assert.deepStrictEqual(list.map(x => x.name), ['Palm Crest']);
    assert.strictEqual(list[0].units.find(u => u.id === studio.id).status, 'sold_out');
    assert.deepStrictEqual((await p.list({ archived: true })).map(x => x.name), ['Palm Crest', 'Marina Vista']);
    await assert.rejects(p.setStatus('unit', studio.id, 'deleted'), /Unknown status/);

    // Reorder units within a project.
    assert.deepStrictEqual(list[0].units.map(u => u.name), ['2 Bedroom + maid', 'Studio']);
    await p.move('unit', studio.id, 'up');
    list = await p.list();
    assert.deepStrictEqual(list[0].units.map(u => u.name), ['Studio', '2 Bedroom + maid']);
    await p.move('unit', studio.id, 'up'); // already first: nothing happens
    assert.deepStrictEqual((await p.list())[0].units.map(u => u.name), ['Studio', '2 Bedroom + maid']);
  } finally { await ctx.cleanup(); }
});

test('R17 catalog needs: a photo (unit or project), a link and a price', () => {
  assert.deepStrictEqual(catalogNeeds({ price_from: 1 }, { photo_url: 'https://x/p.jpg', brochure_url: 'https://x/b.pdf' }), []);
  assert.deepStrictEqual(catalogNeeds({ photo_url: 'https://x/u.jpg', price_from: 1 }, {}), ['link']);
  assert.deepStrictEqual(catalogNeeds({}, { brochure_url: 'https://x' }), ['photo', 'price']);
  assert.deepStrictEqual(catalogNeeds({ price_from: 1 }, {}, { website: 'https://x' }), ['photo']);
});

test('R17 the message: grouped by project, prices in the business currency, Meta\'s limits enforced', async () => {
  const ctx = await setup();
  try {
    const p = new Projects(ctx.db);
    const palm = await p.addProject({ name: 'Palm Crest', area: 'Dubai Hills', handover: 'Q4 2027', brochure_url: 'https://example.com/palm.pdf' });
    const a = await p.addUnit(palm.id, { name: '2 Bedroom', size_sqft: '1250', price_from: '1800000' });
    const b = await p.addUnit(palm.id, { name: 'Studio' });
    const m = await p.message([a.id, b.id], { businessName: 'Acme Homes', currency: 'AED' });
    assert.match(m.text, /^Here are the options from Acme Homes:/);
    assert.match(m.text, /Palm Crest, Dubai Hills \(handover Q4 2027\)\n- 2 Bedroom, 1,250 sq ft, from AED 1,800,000\n- Studio\nBrochure: https:\/\/example\.com\/palm\.pdf/);
    assert.deepStrictEqual(m.units, [a.id, b.id]);

    await p.setStatus('unit', b.id, 'sold_out');
    await assert.rejects(p.message([a.id, b.id]), /sold out or no longer listed/);
    await assert.rejects(p.message([]), /Pick at least one unit/);

    // 31 units, and 11 projects: refused, like a WhatsApp product list would be.
    const many = [];
    for (let i = 0; i < 11; i++) {
      const proj = await p.addProject({ name: `P${i}` });
      for (let j = 0; j < 3; j++) many.push({ id: (await p.addUnit(proj.id, { name: `U${j}` })).id, project: i });
    }
    await assert.rejects(p.message(many.slice(0, SEND_LIMITS.units + 1).map(x => x.id)), /up to 30 units/);
    await assert.rejects(p.message(many.filter(x => x.project <= 10 && many.indexOf(x) % 3 === 0).map(x => x.id)), /up to 10 projects/);
  } finally { await ctx.cleanup(); }
});

test('R17 screens: Projects for owners and managers of a projects business; Send projects is a CRM reply', async () => {
  const ctx = await setup();
  try {
    const owner = await login(ctx.app, 'owner');
    // A gym doesn't sell projects: no menu item (the page still works for an owner who opens it).
    assert.doesNotMatch((await owner.agent.get('/')).text, /href="\/projects"/);

    asDubai();
    assert.match((await owner.agent.get('/')).text, /href="\/projects"/);
    let r = await owner.agent.post('/projects').type('form').send({ _csrf: owner.csrf, name: 'Palm Crest', area: 'Dubai Hills', brochure_url: 'https://example.com/palm.pdf' });
    assert.strictEqual(r.status, 302);
    const proj = await ctx.db.one("SELECT id FROM crm_projects WHERE name = 'Palm Crest'");
    r = await owner.agent.post(`/projects/${proj.id}/units`).type('form').send({ _csrf: owner.csrf, name: '2 Bedroom', price_from: 'AED 1,800,000' });
    assert.strictEqual(r.status, 302);
    const unit = await ctx.db.one('SELECT id FROM crm_units');
    const page = (await owner.agent.get('/projects')).text;
    assert.match(page, /from AED 1,800,000/);
    assert.match(page, /Needs a photo/);
    assert.match(page, /still answers from <a class="link" href="\/settings">Business settings<\/a>/);

    const manager = await login(ctx.app, 'manager');
    assert.strictEqual((await manager.agent.get('/projects')).status, 200);
    const sales = await login(ctx.app, 'sales');
    assert.strictEqual((await sales.agent.get('/projects')).status, 403);
    assert.strictEqual((await sales.agent.post('/projects').type('form').send({ _csrf: sales.csrf, name: 'X' })).status, 403);

    // Send projects from the lead page (window open): one CRM message with the unit ids.
    const leadPage = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(leadPage, /Send projects…/);
    assert.match(leadPage, new RegExp(`name="units" value="${unit.id}"`));
    r = await owner.agent.post(`/leads/${LEAD}/projects`).type('form').send({ _csrf: owner.csrf, units: String(unit.id) });
    assert.strictEqual(r.status, 302);
    assert.match(r.headers.location, /Projects\+sent/);
    const out = await ctx.db.one("SELECT text, metadata FROM outbound_messages WHERE wa_id = $1 AND metadata ->> 'source' = 'crm' ORDER BY id DESC LIMIT 1", [LEAD]);
    assert.match(out.text, /Palm Crest, Dubai Hills\n- 2 Bedroom, from AED 1,800,000\nBrochure: https:\/\/example\.com\/palm\.pdf/);
    assert.deepStrictEqual(out.metadata.units, [unit.id]);
    assert.strictEqual(out.metadata.user_id, await ctx.userId('owner')); // counts as a staff reply (R2, R5)

    // Window closed: the section says why, the form is disabled, and the server refuses too.
    await ctx.db.query("UPDATE leads SET last_inbound_message_at = now() - interval '3 days' WHERE wa_id = $1", [LEAD]);
    const closed = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(closed, /The 24-hour reply window is closed, so WhatsApp won't deliver this/);
    assert.match(closed, /<fieldset disabled class="space-y-2">/);
    const before = (await ctx.db.one('SELECT COUNT(*)::int AS c FROM outbound_messages')).c;
    r = await owner.agent.post(`/leads/${LEAD}/projects`).type('form').send({ _csrf: owner.csrf, units: String(unit.id) });
    assert.match(r.headers.location || '', /err=/);
    assert.strictEqual((await ctx.db.one('SELECT COUNT(*)::int AS c FROM outbound_messages')).c, before);
  } finally { gymConfig.resetToDefault(); await ctx.cleanup(); }
});

test('R17 one client\'s projects never show for another', async () => {
  const ctx = await setup();
  try {
    const acme = await registry.create({ slug: 'acmep', name: 'Acme P', phoneNumberId: '1000200030066', crmHost: 'crm.acmep.test' });
    await tenancy.run(acme.id, async () => {
      const p = new Projects(ctx.db);
      const proj = await p.addProject({ name: 'Acme Towers' });
      await p.addUnit(proj.id, { name: 'Penthouse' });
    });
    const mine = await new Projects(ctx.db).list({ archived: true });
    assert.deepStrictEqual(mine, []);
    assert.strictEqual((await new Projects(ctx.db).sendable()).length, 0);
  } finally { await ctx.cleanup(); }
});

test('R17 review fixes: WhatsApp\'s 4096-character limit, and no projects list to a lead who wrote STOP', async () => {
  const ctx = await setup();
  try {
    const p = new Projects(ctx.db);
    // 10 projects with long brochure links, 3 units each: inside Meta's limits, too long for one text.
    const ids = [];
    for (let i = 0; i < 10; i++) {
      const proj = await p.addProject({ name: `Project ${i}`, area: 'Somewhere', brochure_url: `https://example.com/${'b'.repeat(400)}/${i}.pdf` });
      for (let j = 0; j < 3; j++) ids.push((await p.addUnit(proj.id, { name: `Unit ${j}`, price_from: '1000000' })).id);
    }
    await assert.rejects(p.message(ids), /too long for one WhatsApp message\. Pick fewer units or projects/);
    assert.ok((await p.message(ids.slice(0, 3))).text.length < 4096);

    // Opted out (K30): the section says why, the form is disabled, the server refuses.
    asDubai();
    const owner = await login(ctx.app, 'owner');
    await ctx.db.query('UPDATE leads SET opted_out_at = now() WHERE wa_id = $1', [LEAD]);
    const page = (await owner.agent.get(`/leads/${LEAD}`)).text;
    assert.match(page, /They wrote STOP, so no projects lists/);
    assert.match(page, /<fieldset disabled class="space-y-2">/);
    const before = (await ctx.db.one('SELECT COUNT(*)::int AS c FROM outbound_messages')).c;
    const r = await owner.agent.post(`/leads/${LEAD}/projects`).type('form').send({ _csrf: owner.csrf, units: String(ids[0]) });
    assert.match(r.headers.location || '', /err=They\+wrote\+STOP/);
    assert.strictEqual((await ctx.db.one('SELECT COUNT(*)::int AS c FROM outbound_messages')).c, before);
  } finally { gymConfig.resetToDefault(); await ctx.cleanup(); }
});

test('unit prices: luxury prices fit, anything past the column limit is refused with a message', () => {
  const { unitInput, MAX_PRICE } = require('../../crm/src/projects');
  assert.strictEqual(unitInput({ name: 'Penthouse', price_from: '₹25,00,00,000' }).price_from, 250000000);
  assert.ok(MAX_PRICE <= 2147483647, 'fits crm_units.price_from INTEGER');
  assert.throws(() => unitInput({ name: 'Island', price_from: '3000000000' }), /up to 2,000,000,000/);
});
