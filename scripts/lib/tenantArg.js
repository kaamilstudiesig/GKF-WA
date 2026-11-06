const registry = require('../../src/tenancy/registry');

/**
 * Scripts that act on one tenant take `--tenant <slug>`. Without it they use
 * tenant 1, but only while it is the only tenant (so a command can never land
 * on the wrong client by default). Returns { tenant, args } where args has the
 * --tenant pair removed.
 */
async function tenantFromArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const i = args.indexOf('--tenant');
  let slug = null;
  if (i >= 0) {
    slug = args[i + 1];
    args.splice(i, 2);
    if (!slug) throw new Error('--tenant needs a slug, for example --tenant acme');
  }
  await registry.load();
  if (slug) {
    const tenant = await registry.bySlug(slug);
    if (!tenant) throw new Error(`No tenant "${slug}". See: npm run tenant -- list`);
    return { tenant, args };
  }
  if (registry.list().length > 1) throw new Error('There are several tenants. Pass --tenant <slug> (see: npm run tenant -- list).');
  return { tenant: registry.config(registry.DEFAULT_TENANT_ID), args };
}

module.exports = { tenantFromArgs };
