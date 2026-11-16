const db = require('../db');

/**
 * Deletes everything we hold about one lead, in the current tenant. Used by
 * `npm run delete-lead` (data deletion requests) and by K31 automatic deletion (src/services/retention.js).
 *
 * Tables with a foreign key to leads (messages, hand-offs, notes, follow-ups, assignments, outcomes,
 * Zoho links) go with the lead. The rest are keyed by the same wa_id without a foreign key and are
 * deleted here. Kept on purpose: lead_usage (a keyed hash for billing, no personal data), the
 * opt-out of an opted-out lead (opt_out_list, a keyed hash, so templates stay refused) and
 * reply_times (no lead key). Backups roll over within 30 days.
 */
// Tables without a foreign key to leads. Optional ones are skipped where a database doesn't have them yet.
const NO_FK_TABLES = [
  { table: 'outbound_messages' },
  { table: 'webhook_events' },
  { table: 'crm_activity_log', optional: true },
  { table: 'crm_payment_links', optional: true }, // payment links carry the lead's number and amounts
  { table: 'intake_submissions', optional: true } // R16 lead intake (stores the phone as wa_id)
];
const COUNTED = ['messages', 'handoffs', 'outbound_messages', 'webhook_events'];

const exists = async table => Boolean((await db.one('SELECT to_regclass($1) AS t', [table])).t);

/**
 * { found: false } | { found: true, deleted: boolean, counts, skipped? }. Dry run unless confirm.
 * `onlyIf(key)` (automatic deletion) runs inside the transaction after the lead row is locked; when
 * it returns false (the lead became active meanwhile) nothing is deleted.
 */
async function deleteLead(key, { confirm = false, onlyIf = null } = {}) {
  await db.init();
  const lead = await db.one('SELECT wa_id, phone, display_name, opted_out_at FROM leads WHERE wa_id = $1', [key]);
  if (!lead) return { found: false };
  const tables = [];
  for (const t of NO_FK_TABLES) if (!t.optional || await exists(t.table)) tables.push(t.table);
  const counts = {};
  for (const table of new Set([...COUNTED, ...tables])) {
    counts[table] = (await db.one(`SELECT COUNT(*)::int AS n FROM ${table} WHERE wa_id = $1`, [key])).n;
  }
  if (!confirm) return { found: true, deleted: false, counts };
  const run = async () => {
    // Lock the lead: an inbound message or a staff action waits for us, and we re-check after it.
    const locked = await db.one('SELECT opted_out_at FROM leads WHERE wa_id = $1 FOR UPDATE', [key]);
    if (!locked) return false;
    if (onlyIf && !(await onlyIf(key))) return false;
    // A STOP outlives the deletion, as a keyed hash (src/services/optOutList.js).
    await require('./optOutList').remember({ ...lead, opted_out_at: locked.opted_out_at });
    for (const table of tables) await db.query(`DELETE FROM ${table} WHERE wa_id = $1`, [key]);
    // Staff alerts about this lead are queued to the staff member's number; the lead is in metadata.
    await db.query("DELETE FROM outbound_messages WHERE metadata -> 'staff_alert' ->> 'lead' = $1", [key]);
    await db.query('DELETE FROM leads WHERE wa_id = $1', [key]); // the rest cascades
    return true;
  };
  const done = await db.tx(run);
  return done ? { found: true, deleted: true, counts } : { found: true, deleted: false, counts, skipped: 'active' };
}

module.exports = { deleteLead, NO_FK_TABLES };
