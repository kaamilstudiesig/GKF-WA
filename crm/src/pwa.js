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

const zlib = require('zlib');

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

/**
 * A plain square PNG in one colour. iPhones ignore SVG icons, so without an uploaded
 * logo this is the home-screen icon (a brand-colour tile instead of a page screenshot).
 */
function solidPng(hex, size = 180) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex));
  const [r, g, b] = m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)) : [0xd4, 0xaf, 0x37];
  const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB
  for (let x = 0; x < size; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB, no compression/filter/interlace flags beyond the defaults
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
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

module.exports = { manifest, iconSvg, solidPng, pngSize, BG };
