#!/usr/bin/env node
/**
 * Creates a WhatsApp message template through the Cloud API.
 *   node scripts/create-template.js [trial_confirmation|trial_reminder|staff_lead_alert]
 *   node scripts/create-template.js staff_lead_alert --dry-run  # prints the request only
 * Reads META_ACCESS_TOKEN, META_WABA_ID and BUSINESS_NAME from .env and never prints the token.
 * staff_lead_alert also needs CRM_BASE_URL (its "Open in CRM" button links to <CRM_BASE_URL>/leads/<lead>).
 * Meta reviews each template; staff alerts work after it shows "APPROVED".
 * K8: templates belong to one WhatsApp account. For another tenant, pass its values:
 *   META_WABA_ID=... META_ACCESS_TOKEN=... BUSINESS_NAME="Acme" CRM_BASE_URL=https://crm.acme.com \
 *     node scripts/create-template.js staff_lead_alert
 */
require('dotenv').config({ quiet: true });
const axios = require('axios');

const WABA_ID = process.env.META_WABA_ID;
const BUSINESS = process.env.BUSINESS_NAME;
if (!WABA_ID || !BUSINESS) {
  console.error('Set META_WABA_ID and BUSINESS_NAME (for example in .env) first.');
  process.exit(1);
}
const VERSION = process.env.META_GRAPH_API_VERSION || 'v23.0';
const url = `https://graph.facebook.com/${VERSION}/${WABA_ID}/message_templates`;

const visit = (name, text) => ({
  name,
  category: 'UTILITY',
  language: 'en',
  components: [{ type: 'BODY', text, example: { body_text: [['Rahul', 'Saturday 7 AM']] } }]
});

const crm = (process.env.CRM_BASE_URL || '').replace(/\/+$/, '');
const TEMPLATES = {
  trial_confirmation: () => visit('trial_confirmation',
    `Hi {{1}}, your visit at ${BUSINESS} is booked for {{2}}. Reply here if you need to change the time.`),
  trial_reminder: () => visit('trial_reminder',
    `Hi {{1}}, a quick reminder that your visit at ${BUSINESS} is on {{2}}. Reply here if you need to change the time.`),
  // Staff alert (src/services/staffAlerts.js): {{1}} what happened, {{2}} lead name and number, {{3}} details.
  staff_lead_alert: () => {
    if (!/^https:\/\//.test(crm)) {
      console.error('Set CRM_BASE_URL to the CRM address (https://...) first. The button links there.');
      process.exit(1);
    }
    return {
      name: 'staff_lead_alert',
      category: 'UTILITY',
      language: 'en',
      components: [
        { type: 'HEADER', format: 'TEXT', text: 'Lead alert' },
        {
          type: 'BODY',
          text: 'Staff alert: {{1}}.\n\nLead: {{2}}\nDetails: {{3}}\n\nOpen the lead in the CRM to reply, assign it or log the outcome.',
          example: { body_text: [['Lead needs a person', 'Sample Lead (+919800000000)', 'Asked for a person: wants a visit on Saturday']] }
        },
        { type: 'FOOTER', text: `${BUSINESS} lead assistant`.slice(0, 60) },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open in CRM', url: `${crm}/leads/{{1}}`, example: [`${crm}/leads/919800000000`] }] }
      ]
    };
  }
};
const name = process.argv.slice(2).find(a => !a.startsWith('--')) || 'trial_confirmation';
if (!TEMPLATES[name]) {
  console.error(`Unknown template "${name}". Choose one of: ${Object.keys(TEMPLATES).join(', ')}`);
  process.exit(1);
}
const template = TEMPLATES[name]();

const show = (label, obj) => console.log(`\n${label}\n${JSON.stringify(obj, null, 2)}`);

(async () => {
  console.log(`POST ${url}`);
  show('Request body:', template);
  if (process.argv.includes('--dry-run')) return console.log('\n(dry run, nothing sent)');

  const headers = { Authorization: `Bearer ${process.env.META_ACCESS_TOKEN}` };
  const created = await axios.post(url, template, { headers, timeout: 20000 });
  show('Response from Meta:', created.data);

  const list = await axios.get(url, { headers, params: { fields: 'name,status,category,language', limit: 20 }, timeout: 20000 });
  show('Templates on this WhatsApp account now:', list.data.data);
})().catch(err => {
  show('Error from Meta:', err.response?.data || { message: err.message });
  process.exitCode = 1;
});
