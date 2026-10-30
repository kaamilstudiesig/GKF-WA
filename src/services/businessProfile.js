const db = require('../db');
const gymConfig = require('../config/gymConfig');
const { VERTICALS } = require('../config/verticals');
const logger = require('../utils/logger');

/**
 * The business profile: what the assistant knows about the business. Stored in
 * business_profile, edited on the CRM's Business settings page, and applied to
 * gymConfig (the live view every other module reads). The first load saves the
 * current defaults, so nothing changes until someone edits it.
 */

const LIMITS = { hours: 7, programs: 20, plans: 12, policies: 12, sellingPoints: 10 };
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (v, max, n) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map(x => str(x, max)).filter(Boolean).slice(0, n);
const num = v => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

class ProfileError extends Error {}

/** Cleans and checks a profile. Throws ProfileError with a message staff can act on. */
function normalize(input = {}) {
  const d = gymConfig.DEFAULT_PROFILE;
  const p = {
    name: str(input.name, 80),
    type: VERTICALS[input.type] ? input.type : 'gym',
    area: str(input.area, 120),
    address: str(input.address, 240),
    parking: str(input.parking, 160),
    facility: str(input.facility, 160),
    latitude: num(input.latitude),
    longitude: num(input.longitude),
    voice: str(input.voice, 400) || d.voice,
    hours: list(input.hours, 120, LIMITS.hours),
    programs: list(input.programs, 100, LIMITS.programs),
    plans: (Array.isArray(input.plans) ? input.plans : [])
      .map(x => ({ name: str(x?.name, 60), price: str(x?.price, 60), details: str(x?.details, 240) }))
      .filter(x => x.name && x.price).slice(0, LIMITS.plans),
    policies: (Array.isArray(input.policies) ? input.policies : [])
      .map(x => ({ name: str(x?.name, 60), text: str(x?.text, 400) }))
      .filter(x => x.name && x.text).slice(0, LIMITS.policies),
    sellingPoints: list(input.sellingPoints, 200, LIMITS.sellingPoints),
    fallback: {
      systemError: str(input.fallback?.systemError, 300) || d.fallback.systemError,
      nonTextMessage: str(input.fallback?.nonTextMessage, 300) || d.fallback.nonTextMessage
    }
  };
  if (!p.name) throw new ProfileError('Business name is required.');
  if (!p.address) throw new ProfileError('Address is required.');
  if (!p.hours.length) throw new ProfileError('Add at least one line of opening hours.');
  if (!p.plans.length) throw new ProfileError('Add at least one plan with a name and a price.');
  if ((p.latitude === null) !== (p.longitude === null)) throw new ProfileError('Map pin needs both latitude and longitude, or neither.');
  if (p.latitude !== null && (Math.abs(p.latitude) > 90 || Math.abs(p.longitude) > 180)) throw new ProfileError('Map pin coordinates are out of range.');
  return p;
}

const businessProfile = {
  normalize,
  ProfileError,
  LIMITS,

  /** Loads the saved profile into gymConfig; saves the defaults first if there is none. */
  async load() {
    const row = await db.one('SELECT profile FROM business_profile WHERE id = 1');
    if (!row) {
      await db.query(`INSERT INTO business_profile (id, profile, updated_by) VALUES (1, $1::jsonb, 'defaults')
        ON CONFLICT (id) DO NOTHING`, [JSON.stringify(gymConfig.DEFAULT_PROFILE)]);
      gymConfig.resetToDefault();
      return gymConfig.profile;
    }
    try {
      gymConfig.setProfile(normalize(row.profile));
    } catch (err) {
      logger.error('Saved business profile is invalid; keeping the current one', { error: err.message });
    }
    return gymConfig.profile;
  },

  /** Validates, saves and applies a profile. Returns the saved profile. */
  async save(input, updatedBy = null) {
    const profile = normalize(input);
    await db.query(`INSERT INTO business_profile (id, profile, updated_by, updated_at) VALUES (1, $1::jsonb, $2, now())
      ON CONFLICT (id) DO UPDATE SET profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(profile), updatedBy]);
    gymConfig.setProfile(profile);
    logger.info('Business profile updated', { by: updatedBy });
    return profile;
  },

  async meta() {
    return db.one('SELECT updated_by, updated_at FROM business_profile WHERE id = 1');
  },

  /** Re-reads the profile every minute so every process picks up edits. */
  startRefresh(ms = 60 * 1000) {
    const t = setInterval(() => this.load().catch(err => logger.warn('Profile refresh failed', { error: err.message })), ms);
    t.unref();
    return t;
  }
};

module.exports = businessProfile;
