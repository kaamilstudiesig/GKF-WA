const db = require('../db');

/**
 * Deletes everything we hold about one lead, in the current tenant. Used by
 * `npm run delete-lead` (data deletion requests) and by K31 automatic deletion (src/services/retention.js).
 *
 * Tables with a foreign key to leads (messages, hand-offs, notes, follow-ups, assignments, outcomes,
 * Zoho links) go with the lead. The rest are keyed by the same wa_id without a foreign key and are
 * deleted here. Kept on purpose: lead_usage (a keyed hash for billing, no personal data) and
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

/** { found: false } | { found: true, deleted: boolean, counts }. Dry run unless confirm. */
async function deleteLead(key, { confirm = false } = {}) {
  await db.init();
  const lead = await db.one('SELECT wa_id, display_name FROM leads WHERE wa_id = $1', [key]);
  if (!lead) return { found: false };
  const tables = [];
  for (const t of NO_FK_TABLES) if (!t.optional || await exists(t.table)) tables.push(t.table);
  const counts = {};
  for (const table of new Set([...COUNTED, ...tables])) {
    counts[table] = (await db.one(`SELECT COUNT(*)::int AS n FROM ${table} WHERE wa_id = $1`, [key])).n;
  }
  if (!confirm) return { found: true, deleted: false, counts };
  const run = async () => {
    for (const table of tables) await db.query(`DELETE FROM ${table} WHERE wa_id = $1`, [key]);
    await db.query('DELETE FROM leads WHERE wa_id = $1', [key]); // the rest cascades
  };
  await db.tx(run);
  return { found: true, deleted: true, counts };
}

module.exports = { deleteLead, NO_FK_TABLES };
