const crypto = require('crypto');
const { HttpError } = require('./crm');

/**
 * White-label branding (R12): what the CRM looks like for one business.
 * - name: the business name from the bot's business profile (Business settings).
 * - mark: 1-3 letters in the square logo, defaulting to the name's initials.
 * - color: the primary (accent) colour as #rrggbb.
 * - logo: an optional small PNG/JPEG/WebP image that replaces the letter mark.
 * Stored in crm_branding (one row) and cached for a minute.
 */

const DEFAULT_COLOR = '#d4af37'; // the theme's own primary colour (crm/styles/app.css)
const DEFAULT_CONTENT = '#141106'; // the theme's --color-primary-content
const FALLBACK_NAME = 'Staff CRM';
const LOGO_MAX_BYTES = 40 * 1024;
// No SVG: served from the CRM's own origin, an SVG could run scripts if opened directly.
const LOGO_TYPES = {
  'image/png': b => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': b => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'
};

const cleanName = v => String(v ?? '').replace(/\s+/g, ' ').trim();

/** "Sunrise Dental Clinic" -> "SD"; "Acme" -> "AC". */
function initials(name) {
  const words = cleanName(name).split(' ').filter(w => /[\p{L}\p{N}]/u.test(w));
  if (!words.length) return 'CR';
  // Letters and digits only, so "(Demo) Realty" gives "DR", not "(R".
  const alnum = w => [...w].filter(ch => /[\p{L}\p{N}]/u.test(ch));
  const letters = words.length === 1 ? alnum(words[0]).slice(0, 2) : words.slice(0, 2).map(w => alnum(w)[0]);
  return letters.join('').toUpperCase();
}

/** "#ABC" or "abc123" -> "#aabbcc" / "#abc123"; anything else -> null. */
function normalizeColor(v) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

/** Dark or light text, whichever reads better on the given colour (WCAG relative luminance). */
function contentColor(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Contrast against near-black (#141414, lum ~0.007) vs white (1.0).
  return (lum + 0.05) / 0.057 >= 1.05 / (lum + 0.05) ? '#141414' : '#ffffff';
}

/** Splits a name so the last word can be shown in the brand colour ("Sunrise Dental" + "Clinic"). */
function nameParts(name) {
  const words = cleanName(name).split(' ');
  return words.length > 1 ? { first: words.slice(0, -1).join(' '), last: words[words.length - 1] } : { first: words[0] || '', last: '' };
}

/** "Sunrise Dental" -> "sunrise-dental" (file names). */
const slug = name => cleanName(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'crm';

/** Parses a data: URL from the settings form into a checked logo, or throws HttpError(400). */
function parseLogo(dataUrl) {
  const m = /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, 'The logo must be a PNG, JPEG or WebP image.');
  const type = m[1];
  const data = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!LOGO_TYPES[type] || !LOGO_TYPES[type](data)) throw new HttpError(400, 'The logo must be a PNG, JPEG or WebP image.');
  if (data.length > LOGO_MAX_BYTES) throw new HttpError(400, `The logo is too big. Use an image under ${LOGO_MAX_BYTES / 1024} KB (a 256×256 PNG is plenty).`);
  return { type, data };
}

class Branding {
  /**
   * @param db the shared db module
   * @param nameFn returns the business name (from the bot's business profile), or '' when there is none
   */
  constructor(db, nameFn = () => '', ttlMs = 60 * 1000) {
    this.db = db;
    this.nameFn = nameFn;
    this.ttlMs = ttlMs;
    this.cached = null;
    this.cachedAt = 0;
  }

  async row() {
    if (!this.cached || Date.now() - this.cachedAt > this.ttlMs) {
      this.cached = (await this.db.one(
        'SELECT mark, color, logo_type, logo_data, updated_at FROM crm_branding WHERE id = 1'
      )) || {};
      this.cachedAt = Date.now();
    }
    return this.cached;
  }

  /** What every page needs: name, mark, colours, logo URL. */
  async get() {
    const r = await this.row();
    const name = cleanName(this.nameFn()) || FALLBACK_NAME;
    const color = normalizeColor(r.color) || DEFAULT_COLOR;
    const custom = color !== DEFAULT_COLOR;
    const version = r.updated_at ? crypto.createHash('sha1').update(String(new Date(r.updated_at).getTime())).digest('hex').slice(0, 8) : '';
    return {
      name,
      ...nameParts(name),
      mark: r.mark || initials(name),
      markIsDefault: !r.mark,
      color,
      contentColor: custom ? contentColor(color) : DEFAULT_CONTENT,
      // Only override the theme when the colour differs, so the default look stays exactly the same.
      style: custom ? `--color-primary:${color};--color-primary-content:${contentColor(color)}` : '',
      logoUrl: r.logo_data ? `/brand/logo?v=${version}` : null,
      fileSlug: slug(name)
    };
  }

  async logo() {
    const r = await this.row();
    return r.logo_data ? { type: r.logo_type, data: Buffer.from(r.logo_data) } : null;
  }

  /**
   * Saves branding from the settings form. Fields: mark, color, logo (data URL, optional),
   * remove_logo ('1' to delete the logo). Throws HttpError(400) with a message staff can act on.
   */
  async save(input, updatedBy = null) {
    const mark = cleanName(input.mark).replace(/\s/g, '');
    if ([...mark].length > 3 || /[^\p{L}\p{N}]/u.test(mark)) throw new HttpError(400, 'Logo letters: up to 3 letters or digits, like GK.');
    const color = normalizeColor(input.color);
    if (!color) throw new HttpError(400, 'Pick a brand colour like #d4af37.');
    const logo = input.logo ? parseLogo(input.logo) : null;
    const removeLogo = input.remove_logo === '1';

    const current = await this.db.one('SELECT logo_type, logo_data FROM crm_branding WHERE id = 1');
    const keep = !removeLogo && !logo && current ? current : { logo_type: null, logo_data: null };
    const next = logo ? { logo_type: logo.type, logo_data: logo.data } : keep;

    await this.db.query(`INSERT INTO crm_branding (id, mark, color, logo_type, logo_data, updated_by, updated_at)
      VALUES (1, $1, $2, $3, $4, $5, now())
      ON CONFLICT (id) DO UPDATE SET mark = EXCLUDED.mark, color = EXCLUDED.color, logo_type = EXCLUDED.logo_type,
        logo_data = EXCLUDED.logo_data, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [mark.toUpperCase() || null, color, next.logo_type, next.logo_data, updatedBy]);
    this.cached = null;
  }
}

module.exports = { Branding, initials, normalizeColor, contentColor, nameParts, slug, parseLogo, DEFAULT_COLOR, DEFAULT_CONTENT, LOGO_MAX_BYTES };
