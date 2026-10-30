const express = require('express');
const gymConfig = require('../config/gymConfig');

/**
 * Public legal pages Meta asks for in App Review: privacy policy, terms and
 * data-deletion instructions. Served on the bot host (e.g. wa.goldkraftfitness.com/privacy).
 * Plain HTML with inline styles only; no scripts, no external resources.
 */

const UPDATED = '30 October 2026';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function contact() {
  const email = process.env.LEGAL_CONTACT_EMAIL || '';
  const phone = process.env.LEGAL_CONTACT_PHONE || '';
  const parts = [];
  if (email) parts.push(`email <a href="mailto:${esc(email)}">${esc(email)}</a>`);
  if (phone) parts.push(`WhatsApp or call ${esc(phone)}`);
  parts.push(`message the ${esc(gymConfig.gymName)} WhatsApp number you chatted with`);
  return parts.join(', or ');
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(gymConfig.gymName)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 18px 64px; }
  h1 { font-size: 30px; line-height: 1.2; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 28px 0 6px; }
  p, li { margin: 6px 0; }
  .muted { opacity: .7; font-size: 14px; }
  nav { display: flex; gap: 16px; flex-wrap: wrap; font-size: 14px; margin-bottom: 24px; }
  a { color: LinkText; }
</style></head>
<body><main>
<nav><a href="/privacy">Privacy policy</a><a href="/terms">Terms</a><a href="/data-deletion">Delete your data</a></nav>
${body}
</main></body></html>`;
}

const name = () => esc(gymConfig.gymName);

function privacyHtml() {
  return page('Privacy policy', `
<h1>Privacy policy</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>This policy explains how ${name()} ("we") handles your information when you message us on WhatsApp or when our staff use our customer management system. It covers our WhatsApp assistant and our staff CRM.</p>

<h2>What we collect</h2>
<ul>
  <li>Your WhatsApp profile name, your WhatsApp number or WhatsApp user ID, and your username if you have one.</li>
  <li>The messages you send us and our replies, with dates and times.</li>
  <li>What you tell us about your goals, experience and preferred timings, and notes our staff add.</li>
  <li>If you reached us from a Facebook or Instagram ad: the ad you clicked (for example its ID and headline).</li>
</ul>
<p>We do not ask for payment card details, passwords or government ID numbers on WhatsApp.</p>

<h2>Why we use it</h2>
<ul>
  <li>To answer your questions quickly, including with an automated assistant that uses AI.</li>
  <li>To have the right staff member follow up, book a trial or visit, and keep track of your enquiry.</li>
  <li>To understand which of our ads and channels bring people to us, and to improve our service.</li>
  <li>To keep our service safe and working (for example error logs and backups).</li>
</ul>

<h2>Automated replies</h2>
<p>Many replies come from an automated assistant. It answers from information about ${name()} only. It does not give medical advice; injury or health questions are passed to our staff. You can ask for a person at any time.</p>

<h2>Who processes your information for us</h2>
<ul>
  <li>Meta Platforms (WhatsApp Business Platform), to send and receive messages.</li>
  <li>AI model providers reached through OpenRouter, to write automated replies. They receive the conversation text needed to reply, not your phone number.</li>
  <li>Our hosting and database provider (Heroku, a Salesforce company), and our error-monitoring provider (Sentry).</li>
  <li>Telegram, to alert our staff about enquiries that need a person.</li>
</ul>
<p>We do not sell your information.</p>

<h2>How long we keep it</h2>
<p>We keep your enquiry and conversation while it is useful for serving you, and for up to 24 months after your last message, unless you ask us to delete it sooner. Technical queues and logs are deleted automatically within 30 days.</p>

<h2>Your choices and rights</h2>
<ul>
  <li>Ask what information we hold about you, or ask us to correct it.</li>
  <li>Ask us to delete your information (see <a href="/data-deletion">how to delete your data</a>).</li>
  <li>Stop messaging us at any time. We only reply to messages you send, and we will not send you promotions without your consent.</li>
</ul>

<h2>Security</h2>
<p>Data is sent over encrypted connections, staff access is limited by role and password, and we keep daily backups.</p>

<h2>Contact</h2>
<p>For any privacy question or request: ${contact()}.</p>
<p>We may update this policy; the date at the top shows the latest version.</p>`);
}

function termsHtml() {
  return page('Terms', `
<h1>Terms of service</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>These terms apply when you message ${name()} on WhatsApp.</p>
<h2>The service</h2>
<p>Our WhatsApp assistant answers questions about ${name()} (plans, prices, timings, location) and connects you with our staff. Some replies are automated. Information is given in good faith; prices, offers and bookings are only final once a staff member confirms them.</p>
<h2>Not medical advice</h2>
<p>Nothing in our messages is medical advice. Please speak to a doctor about injuries or health conditions before training.</p>
<h2>Fair use</h2>
<p>Please don't send abusive, illegal or spam messages. We may stop replying to accounts that do.</p>
<h2>Your data</h2>
<p>See our <a href="/privacy">privacy policy</a>.</p>
<h2>Contact</h2>
<p>${contact()}.</p>`);
}

function deletionHtml() {
  return page('Delete your data', `
<h1>How to delete your data</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>You can ask ${name()} to delete the information we hold about you (your name, number or WhatsApp ID, messages and notes).</p>
<h2>The easiest way</h2>
<p>Send <strong>DELETE MY DATA</strong> to the ${name()} WhatsApp number you chatted with. Our team will confirm on WhatsApp.</p>
<h2>Other ways</h2>
<p>You can also ${contact()}. Tell us the WhatsApp number or name you used.</p>
<h2>What happens next</h2>
<ul>
  <li>We delete your enquiry, conversation history and staff notes within 30 days and confirm when it's done.</li>
  <li>Copies in backups are overwritten within 30 days after that.</li>
  <li>We may keep a minimal record if the law requires it (for example invoices if you became a member).</li>
</ul>
<p>Messages also stay in your own WhatsApp app; you can delete those yourself.</p>`);
}

function legalRouter() {
  const router = express.Router();
  const send = html => (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('html').send(html());
  };
  router.get(['/privacy', '/privacy-policy'], send(privacyHtml));
  router.get(['/terms', '/terms-of-service'], send(termsHtml));
  router.get(['/data-deletion', '/delete-my-data'], send(deletionHtml));
  return router;
}

module.exports = { legalRouter, privacyHtml, termsHtml, deletionHtml };
