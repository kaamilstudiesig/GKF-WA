const db = require('../db');
const gymConfig = require('../config/gymConfig');
const { VERTICALS } = require('../config/verticals');
const logger = require('../utils/logger');
const tenancy = require('../tenancy/context');
const registry = require('../tenancy/registry');

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

/** A neutral starting profile for a new tenant (never another business's facts). */
function starterProfile({ name = 'New business', type = 'services' } = {}) {
  const d = gymConfig.DEFAULT_PROFILE;
  return normalize({
    name, type: VERTICALS[type] ? type : 'services',
    area: '', address: 'Address not set yet', parking: '', facility: '',
    voice: d.voice,
    hours: ['Hours not set yet'],
    programs: [],
    plans: [{ name: 'Plans', price: 'Ask our team', details: '' }],
    policies: [], sellingPoints: [],
    fallback: {
      systemError: `Thanks for messaging ${name}! Someone from our team will get back to you shortly.`,
      nonTextMessage: d.fallback.nonTextMessage
    }
  });
}

const businessProfile = {
  normalize,
  starterProfile,
  ProfileError,
  LIMITS,

  /**
   * Loads the current tenant's saved profile into gymConfig. Tenant 1 saves the
   * GKF defaults on first run (as before K8); other tenants get a neutral starter.
   */
  async load() {
    const tenantId = tenancy.tenantId();
    const row = await db.one('SELECT profile FROM business_profile'); // row-level security: this tenant's row
    if (!row) {
      const t = registry.config(tenantId);
      const profile = tenantId === registry.DEFAULT_TENANT_ID ? gymConfig.DEFAULT_PROFILE : starterProfile({ name: t ? t.name : undefined });
      await db.query(`INSERT INTO business_profile (profile, updated_by) VALUES ($1::jsonb, 'defaults')
        ON CONFLICT (tenant_id) DO NOTHING`, [JSON.stringify(profile)]);
      gymConfig.setProfile(profile, tenantId);
      return gymConfig.profile;
    }
    try {
      gymConfig.setProfile(normalize(row.profile), tenantId);
    } catch (err) {
      logger.error('Saved business profile is invalid; keeping the current one', { tenant: tenantId, error: err.message });
      if (!gymConfig.profileFor(tenantId)) gymConfig.setProfile(row.profile, tenantId);
    }
    return gymConfig.profile;
  },

  /** Loads the current tenant's profile if this process has not yet (a tenant added by another process). */
  async ensureLoaded() {
    if (!gymConfig.profileFor(tenancy.tenantId())) await this.load();
  },

  /** Loads every tenant's profile (startup and the refresh timer). */
  async loadAll() {
    await registry.load();
    for (const t of registry.list()) {
      try {
        await tenancy.run(t.id, () => this.load());
      } catch (err) {
        logger.error('Failed to load a business profile', { tenant: t.slug, error: err.message });
      }
    }
  },

  /** Validates, saves and applies the current tenant's profile. Returns the saved profile. */
  async save(input, updatedBy = null) {
    const profile = normalize(input);
    await db.query(`INSERT INTO business_profile (profile, updated_by, updated_at) VALUES ($1::jsonb, $2, now())
      ON CONFLICT (tenant_id) DO UPDATE SET profile = EXCLUDED.profile, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(profile), updatedBy]);
    gymConfig.setProfile(profile);
    logger.info('Business profile updated', { by: updatedBy, tenant: tenancy.tenantId() });
    return profile;
  },

  async meta() {
    return db.one('SELECT updated_by, updated_at FROM business_profile');
  },

  /** Re-reads every profile every minute so every process picks up edits. */
  startRefresh(ms = 60 * 1000) {
    const t = setInterval(() => this.loadAll().catch(err => logger.warn('Profile refresh failed', { error: err.message })), ms);
    t.unref();
    return t;
  }
};

module.exports = businessProfile;
