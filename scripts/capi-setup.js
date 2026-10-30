#!/usr/bin/env node
/**
 * Finds (or creates) the Conversions API dataset for the WhatsApp Business Account.
 *   node scripts/capi-setup.js            # shows the dataset, if there is one
 *   node scripts/capi-setup.js --create   # creates it when missing
 * Then set META_DATASET_ID (and META_WABA_ID) on the server. Never prints the token.
 */
require('dotenv').config({ quiet: true });
const axios = require('axios');

const waba = process.env.META_WABA_ID;
const token = process.env.META_ACCESS_TOKEN;
const version = process.env.META_GRAPH_API_VERSION || 'v23.0';
if (!waba || !token) {
  console.error('Set META_WABA_ID and META_ACCESS_TOKEN first (in .env or the environment).');
  process.exit(1);
}
const url = `https://graph.facebook.com/${version}/${waba}/dataset`;
const headers = { Authorization: `Bearer ${token}` };

(async () => {
  const existing = await axios.get(url, { headers, timeout: 15000 });
  const found = existing.data?.data?.[0]?.id || existing.data?.id;
  if (found) return console.log(`Dataset for WABA ${waba}: ${found}\nSet META_DATASET_ID=${found}`);
  if (!process.argv.includes('--create')) return console.log(`No dataset yet for WABA ${waba}. Run again with --create to make one.`);
  const created = await axios.post(url, null, { headers, timeout: 15000 });
  const id = created.data?.id || created.data?.dataset_id;
  console.log(`Created dataset ${id} for WABA ${waba}\nSet META_DATASET_ID=${id}`);
})().catch(err => {
  console.error('Meta error:', JSON.stringify(err.response?.data || { message: err.message }));
  process.exitCode = 1;
});
