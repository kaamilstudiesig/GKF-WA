const { toCsv } = require('./csv');
const { makeZip } = require('./zip');

/**
 * R19: the full data export. Owners download one ZIP with a CSV per table: everything
 * this client has with us, so they never need to ask (client agreement 7.6 and, at exit, 12.5).
 * Runs inside the client's tenant context: row-level security keeps it to this client's rows.
 * Never includes passwords, sessions, tokens or other clients' data.
 */
const FILES = [
  {
    name: 'leads.csv',
    about: 'One row per lead. wa_id is the lead key (a phone number, or Meta\'s user id when the phone is hidden). metadata holds what came with the lead (for example the ad it came from).',
    columns: ['wa_id', 'phone', 'username', 'display_name', 'status', 'interest', 'source', 'needs_human', 'handoff_reason', 'notes',
      'first_contact_at', 'last_inbound_message_at', 'last_outbound_message_at', 'created_at', 'updated_at', 'metadata'],
    sql: `SELECT wa_id, phone, username, display_name, status, interest, source, needs_human, handoff_reason, notes,
      first_contact_at, last_inbound_message_at, last_outbound_message_at, created_at, updated_at, metadata
      FROM leads ORDER BY first_contact_at, wa_id`
  },
  {
    name: 'messages.csv',
    about: 'Every WhatsApp message, in and out (direction "in" = from the lead, "out" = sent by the assistant or staff), oldest first per lead.',
    columns: ['id', 'wa_id', 'direction', 'text', 'timestamp', 'whatsapp_message_id'],
    sql: 'SELECT id, wa_id, direction, text, timestamp, message_id AS whatsapp_message_id FROM messages ORDER BY wa_id, timestamp, id'
  },
  {
    name: 'outcomes.csv',
    about: 'What staff logged after following a lead up (called, visit booked, joined with the amount, lost with the reason). amount is in whole units of the business\'s currency.',
    columns: ['id', 'wa_id', 'outcome', 'plan', 'amount', 'lost_reason', 'visit_at', 'note', 'logged_by', 'logged_by_email', 'created_at', 'sent_to_meta'],
    sql: `SELECT o.id, o.wa_id, o.outcome, o.plan, o.amount_inr AS amount, o.lost_reason, o.visit_at, o.note,
      u.name AS logged_by, u.email AS logged_by_email, o.created_at, o.meta_status AS sent_to_meta
      FROM crm_lead_outcomes o LEFT JOIN crm_users u ON u.id = o.user_id ORDER BY o.created_at, o.id`
  },
  {
    name: 'notes.csv',
    about: 'Notes staff wrote on leads.',
    columns: ['id', 'wa_id', 'note', 'written_by', 'written_by_email', 'created_at'],
    sql: `SELECT n.id, n.wa_id, n.body AS note, u.name AS written_by, u.email AS written_by_email, n.created_at
      FROM crm_lead_notes n LEFT JOIN crm_users u ON u.id = n.user_id ORDER BY n.created_at, n.id`
  },
  {
    name: 'assignments.csv',
    about: 'Who each lead is assigned to now. assigned_by is empty when the lead queue assigned it.',
    columns: ['wa_id', 'assigned_to', 'assigned_to_email', 'assigned_by', 'assigned_at'],
    sql: `SELECT a.wa_id, u.name AS assigned_to, u.email AS assigned_to_email, b.name AS assigned_by, a.assigned_at
      FROM crm_lead_assignments a LEFT JOIN crm_users u ON u.id = a.user_id LEFT JOIN crm_users b ON b.id = a.assigned_by
      ORDER BY a.assigned_at, a.wa_id`
  },
  {
    name: 'handoffs.csv',
    about: 'Each time the assistant passed a lead to a person, why, and when it was resolved.',
    columns: ['id', 'wa_id', 'status', 'reason', 'summary', 'assigned_to', 'created_at', 'resolved_at'],
    sql: 'SELECT id, wa_id, status, reason, summary, assigned_to, created_at, resolved_at FROM handoffs ORDER BY created_at, id'
  },
  {
    name: 'follow_ups.csv',
    about: 'Follow-up tasks on leads (calls to make, visits to check), open or done.',
    columns: ['id', 'wa_id', 'title', 'status', 'due_at', 'completed_at', 'owner', 'created_at'],
    sql: `SELECT f.id, f.wa_id, f.title, f.status, f.due_at, f.completed_at, u.name AS owner, f.created_at
      FROM crm_follow_ups f LEFT JOIN crm_users u ON u.id = f.user_id ORDER BY f.created_at, f.id`
  },
  {
    name: 'payment_links.csv',
    about: 'Payment links sent from the CRM and whether they were paid. amount is in whole units of the business\'s currency.',
    columns: ['id', 'wa_id', 'plan', 'amount', 'status', 'link', 'paid_at', 'sent_by', 'created_at'],
    sql: `SELECT p.id, p.wa_id, p.plan, p.amount_inr AS amount, p.status, p.short_url AS link, p.paid_at, u.name AS sent_by, p.created_at
      FROM crm_payment_links p LEFT JOIN crm_users u ON u.id = p.user_id ORDER BY p.created_at, p.id`
  },
  {
    name: 'staff.csv',
    about: 'Everyone with a CRM login (no passwords).',
    columns: ['name', 'email', 'role', 'manager', 'active', 'created_at'],
    sql: `SELECT u.name, u.email, u.role, m.name AS manager, u.active, u.created_at
      FROM crm_users u LEFT JOIN crm_users m ON m.id = u.manager_id ORDER BY u.created_at, u.id`
  }
];

function readme({ businessName, currency, when, counts }) {
  return [
    `Data export for ${businessName}`,
    `Made ${when.toISOString()} (times in every file are UTC, ISO 8601).`,
    `Amounts are whole units of ${currency}.`,
    '',
    'Files (rows in brackets):',
    ...FILES.map(f => `- ${f.name} (${counts[f.name]}): ${f.about}`),
    '',
    'Every file is UTF-8 CSV with a header row. Leads are linked across files by wa_id.',
    ''
  ].join('\r\n');
}

/**
 * Builds the ZIP for the current tenant. Returns { zip: Buffer, counts: { 'leads.csv': n, ... } }.
 * Queries run one after another (inside one tenant transaction context).
 */
async function buildExport(db, { businessName = 'Business', currency = 'INR', when = new Date() } = {}) {
  const files = []; const counts = {};
  for (const f of FILES) {
    const rows = await db.many(f.sql);
    counts[f.name] = rows.length;
    files.push({ name: f.name, data: toCsv(f.columns, rows, { bom: true }) });
  }
  files.unshift({ name: 'README.txt', data: readme({ businessName, currency, when, counts }) });
  return { zip: makeZip(files, when), counts };
}

module.exports = { buildExport, FILES };
