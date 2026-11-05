const db = require('../db');
const env = require('../config/env');
const logger = require('../utils/logger');
const signals = require('../workers/signals');

/**
 * Staff alerts on WhatsApp (next to the Telegram group alerts).
 *
 * Each staff member sets a WhatsApp number and a mode on the CRM Staff page:
 *   off  - no alerts
 *   mine - leads assigned to them (a manager: also their team's leads)
 *   all  - every lead
 * Staff do not message the business number first, so every alert is the approved
 * utility template (scripts/create-template.js staff_lead_alert). It goes through
 * the outbound queue, so it gets the same retries and per-number ordering.
 */
const EVENTS = {
  handoff: { label: 'Lead needs a person', windowMin: 5 },
  lead_message: { label: 'Lead sent a new message', windowMin: 30 }, // one alert per lead per 30 min
  payment: { label: 'Payment received', windowMin: 5 }
};

const MISSING_CRM = new Set(['42P01', '42703']); // CRM tables not migrated yet: no alerts

/** Meta rejects template values with new lines, tabs or more than 4 spaces in a row. */
function clean(value, max = 200) {
  const s = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return (s.length > max ? s.slice(0, max - 1) + '…' : s) || '-';
}

async function recipients(waId) {
  try {
    return await db.many(`
      SELECT u.id, u.alert_phone FROM crm_users u
      WHERE u.active AND u.alert_mode <> 'off' AND u.alert_phone IS NOT NULL
        AND (u.alert_mode = 'all' OR EXISTS (
          SELECT 1 FROM crm_lead_assignments a JOIN crm_users s ON s.id = a.user_id
          WHERE a.wa_id = $1 AND (a.user_id = u.id OR s.manager_id = u.id)))
      ORDER BY u.id`, [waId]);
  } catch (err) {
    if (MISSING_CRM.has(err.code)) return [];
    throw err;
  }
}

/** True when the number belongs to a staff member: the AI does not answer staff. */
async function isStaffPhone(waId) {
  if (!/^[0-9]{8,15}$/.test(String(waId || ''))) return false;
  try {
    return Boolean(await db.one('SELECT 1 AS yes FROM crm_users WHERE active AND alert_phone = $1 LIMIT 1', [String(waId)]));
  } catch (err) {
    if (MISSING_CRM.has(err.code)) return false;
    throw err;
  }
}

function leadLabel(lead, waId) {
  const name = lead?.display_name || 'Unknown name';
  const phone = lead?.phone || (/^[0-9]+$/.test(String(waId)) ? String(waId) : null);
  return phone ? `${name} (+${phone})` : name;
}

/**
 * Queues one alert per staff member who should get it. Returns how many were queued.
 * Never throws: an alert problem must not break the reply flow.
 */
async function alert({ waId, event, details = '' }) {
  try {
    const kind = EVENTS[event];
    if (!kind || !waId) return 0;
    const people = (await recipients(waId)).filter(p => p.alert_phone !== String(waId));
    if (!people.length) return 0;
    const leadRepository = require('../db/leadRepository'); // lazy: avoids a require cycle
    const outboundRepository = require('../db/outboundRepository');
    const lead = await leadRepository.findByWaId(waId);
    const body = [clean(kind.label, 60), clean(leadLabel(lead, waId), 120), clean(details, 300)];
    const bucket = Math.floor(Date.now() / (kind.windowMin * 60000));
    let queued = 0;
    for (const p of people) {
      const id = await outboundRepository.enqueue({
        dedupKey: `staff_alert:${event}:${waId}:${p.id}:${bucket}`,
        waId: p.alert_phone,
        text: `[Staff alert] ${body.join(' · ')}`,
        metadata: {
          staff_alert: { event, lead: String(waId), user_id: p.id },
          template: { name: env.staffAlertTemplate, language: env.staffAlertLanguage, body, button: String(waId) }
        }
      });
      if (id) queued++;
    }
    if (queued) {
      signals.emit('outbound');
      logger.info('Staff WhatsApp alerts queued', { event, count: queued });
    }
    return queued;
  } catch (err) {
    logger.error('Failed to queue staff WhatsApp alerts', { event, error: err.message });
    return 0;
  }
}

module.exports = { alert, recipients, isStaffPhone, clean, EVENTS };
