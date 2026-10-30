#!/usr/bin/env node
/**
 * Creates a WhatsApp message template through the Cloud API (Meta App Review video 2).
 *   node scripts/create-template.js [trial_confirmation|trial_reminder]
 *   node scripts/create-template.js --dry-run  # prints the request only
 * Reads META_ACCESS_TOKEN from .env and never prints it.
 */
require('dotenv').config({ quiet: true });
const axios = require('axios');

const WABA_ID = process.env.META_WABA_ID || '1126778653019949';
const VERSION = process.env.META_GRAPH_API_VERSION || 'v23.0';
const url = `https://graph.facebook.com/${VERSION}/${WABA_ID}/message_templates`;

const TEMPLATES = {
  trial_confirmation: 'Hi {{1}}, your trial at Goldkraft Fitness is booked for {{2}}. Reply here if you need to change the time.',
  trial_reminder: 'Hi {{1}}, a quick reminder that your trial at Goldkraft Fitness is on {{2}}. Reply here if you need to change the time.'
};
const name = process.argv.slice(2).find(a => !a.startsWith('--')) || 'trial_confirmation';
if (!TEMPLATES[name]) {
  console.error(`Unknown template "${name}". Choose one of: ${Object.keys(TEMPLATES).join(', ')}`);
  process.exit(1);
}

const template = {
  name,
  category: 'UTILITY',
  language: 'en',
  components: [{
    type: 'BODY',
    text: TEMPLATES[name],
    example: { body_text: [['Rahul', 'Saturday 7 AM']] }
  }]
};

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
