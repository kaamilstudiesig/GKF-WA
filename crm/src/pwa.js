/**
 * R4: the CRM as an installable phone app (PWA). Per client, from the branding (R12):
 * the app name, colours and icon follow the business, so each client's staff
 * install "their" app from their own CRM host.
 *
 * - /manifest.webmanifest: name, icons, start page, shortcuts.
 * - /brand/icon.svg: the logo letters on the brand colour (used when no logo image is uploaded).
 * - /sw.js: the service worker (crm/public/sw.js with this deploy's asset version).
 *   It caches only the CSS, JS and the offline page, never other pages: lead data is private and
 *   phones are shared. Offline, pages show /offline instead.
 */

const BG = '#0e0e0e'; // the theme's base-200, as in head.ejs

const xml = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

/** Square app icon: logo letters on the brand colour. `pad` leaves room for Android's round mask. */
function iconSvg(brand, { pad = false } = {}) {
  const size = 512;
  const font = brand.mark.length > 2 ? 150 : 210;
  const radius = pad ? 0 : 96;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`
    + `<rect width="${size}" height="${size}" rx="${radius}" fill="${xml(brand.color)}"/>`
    + `<text x="50%" y="50%" dy="0.35em" text-anchor="middle" font-family="Arial Black, Arial, Helvetica, sans-serif" font-weight="900"`
    + ` font-size="${pad ? Math.round(font * 0.8) : font}" fill="${xml(brand.contentColor)}">${xml(brand.mark)}</text></svg>`;
}

/** Width and height of a PNG from its header; null for anything else. */
function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** The web app manifest for this client. `logo` = { type, data } when one is uploaded. */
function manifest(brand, logo = null) {
  const icons = [
    { src: '/brand/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/brand/icon.svg?maskable=1', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
  ];
  const size = logo && logo.type === 'image/png' ? pngSize(logo.data) : null;
  if (size && size.width === size.height) icons.unshift({ src: brand.logoUrl, sizes: `${size.width}x${size.height}`, type: 'image/png', purpose: 'any' });
  return {
    id: '/',
    name: brand.name,
    short_name: brand.name.length <= 12 ? brand.name : brand.first.length <= 12 && brand.first ? brand.first : brand.mark,
    description: `Leads, follow-ups and sales for the ${brand.name} team.`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: BG,
    theme_color: BG,
    icons,
    shortcuts: [
      { name: 'Leads', url: '/leads?needs_human=1', description: 'Leads waiting on a person' },
      { name: 'Follow-ups', url: '/followups' },
      { name: 'Pipeline', url: '/pipeline' }
    ]
  };
}

module.exports = { manifest, iconSvg, pngSize, BG };
