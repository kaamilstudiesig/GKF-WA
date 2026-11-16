const db = require('../db');
const tenancy = require('../tenancy/context');
const { personKey } = require('./leadUsage');

/**
 * K30 + K31: a STOP outlives the lead's deletion. When an opted-out lead is deleted (automatic
 * deletion or a deletion request), a keyed hash of its number goes on this list (no number kept,
 * like the lead meter). Templates to a listed number are refused. If the person shows up again
 * (they message us, or a form brings them back), the opt-out moves back onto the new lead row,
 * where the normal K30 rules apply (a real message from them clears it; "ok" keeps it).
 */
const identityOf = lead => (lead && (lead.phone || lead.wa_id)) || null;
const keyFor = identity => personKey(tenancy.tenantId(), identity);

/** Before deleting an opted-out lead: remember the opt-out. */
async function remember(lead) {
  const identity = identityOf(lead);
  if (!identity || !lead.opted_out_at) return false;
  await db.query('INSERT INTO opt_out_list (person_key, opted_out_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [keyFor(identity), lead.opted_out_at]);
  return true;
}

/** Whether this phone or lead key is on the list. */
async function isListed(waIdOrPhone) {
  if (!waIdOrPhone) return false;
  return Boolean(await db.one('SELECT 1 AS yes FROM opt_out_list WHERE person_key = $1', [keyFor(String(waIdOrPhone))]));
}

/**
 * For a lead row that just appeared again: if its number is listed, puts the opt-out back on the
 * row and takes it off the list. Returns the opted_out_at it restored, or null.
 */
async function restore(lead) {
  const identity = identityOf(lead);
  if (!identity || lead.opted_out_at) return null;
  const row = await db.one('DELETE FROM opt_out_list WHERE person_key = $1 RETURNING opted_out_at', [keyFor(identity)]);
  if (!row) return null;
  await db.query('UPDATE leads SET opted_out_at = $2, updated_at = now() WHERE wa_id = $1', [lead.wa_id, row.opted_out_at]);
  return row.opted_out_at;
}

module.exports = { remember, isListed, restore };
