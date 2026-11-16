const crypto = require('crypto');

/**
 * R16: Business settings -> Lead sources (contract in docs/TEAM.md). Reads and writes the
 * client's intake settings in the tenant registry (src/tenancy/registry.js); the endpoint itself
 * is on the bot host (src/routes/intake.js).
 */

const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
const LOCAL_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|[a-z0-9-]+\.localhost)(:\d{1,5})?$/; // testing a site locally

/** One allowed website per line -> ['https://example.com', ...]; throws with a message staff can act on. */
function parseOrigins(text) {
  const out = [];
  for (const line of String(text || '').split(/[\n,]/)) {
    let o = line.trim().toLowerCase();
    if (!o) continue;
    if (!/^https?:\/\//.test(o)) o = `https://${o}`;
    try { o = new URL(o).origin; } catch (e) { throw new Error(`"${line.trim()}" is not a website address.`); }
    if (!ORIGIN_RE.test(o) && !LOCAL_ORIGIN_RE.test(o)) throw new Error(`"${line.trim()}": use the https address of your website, like https://www.example.com.`);
    if (!out.includes(o)) out.push(o);
  }
  if (out.length > 10) throw new Error('Up to 10 websites.');
  return out;
}

function parseCountry(v) {
  const c = String(v || '').replace(/[^0-9]/g, '');
  if (!/^[1-9][0-9]{0,3}$/.test(c)) throw new Error('Country code: digits only, like 91 for India or 971 for the UAE.');
  return c;
}

const newFormKey = () => crypto.randomBytes(18).toString('base64url');
const newSecret = () => crypto.randomBytes(32).toString('hex');

/** The copy-paste website form. Plain HTML and a few lines of JS; posts urlencoded (no CORS preflight). */
function snippet({ endpoint, formKey, businessName }) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<form id="lead-form">
  <input name="name" placeholder="Your name" required>
  <input name="phone" type="tel" placeholder="WhatsApp number" required>
  <input name="email" type="email" placeholder="Email (optional)">
  <textarea name="message" placeholder="What are you looking for?"></textarea>
  <label><input type="checkbox" name="consent" value="true"> ${esc(businessName)} may message me on WhatsApp about my enquiry</label>
  <input name="company_url" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
  <button type="submit">Send</button>
  <p id="lead-form-msg"></p>
</form>
<script>
(function () {
  var f = document.getElementById('lead-form');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var d = new URLSearchParams(new FormData(f));
    d.set('form_key', '${formKey}');
    var q = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(function (k) { if (q.get(k)) d.set(k, q.get(k)); });
    fetch('${endpoint}', { method: 'POST', body: d }).then(function (r) {
      document.getElementById('lead-form-msg').textContent = r.ok ? 'Thanks! We will be in touch shortly.' : 'Sorry, that did not go through. Please check your number and try again.';
      if (r.ok) f.reset();
    });
  });
})();
</script>`;
}

/** What the settings page shows: settings, endpoint, snippet and the last 20 submissions. Never the secret. */
async function intakeView(db, { cfg, slug, botBaseUrl, businessName }) {
  const endpoint = botBaseUrl ? `${botBaseUrl}/intake/${slug}` : `/intake/${slug}`;
  const recent = await db.many(`SELECT s.received_at, s.channel, s.source, s.status, s.error, s.wa_id, l.display_name
    FROM intake_submissions s LEFT JOIN leads l ON l.wa_id = s.wa_id ORDER BY s.id DESC LIMIT 20`);
  return {
    endpoint, botBaseUrl, formKey: cfg.formKey, origins: cfg.origins, phoneCountry: cfg.phoneCountry,
    welcomeTemplate: cfg.welcomeTemplate, hasSecret: Boolean(cfg.secret), recent,
    snippet: cfg.formKey ? snippet({ endpoint, formKey: cfg.formKey, businessName }) : null
  };
}

module.exports = { parseOrigins, parseCountry, newFormKey, newSecret, snippet, intakeView };
