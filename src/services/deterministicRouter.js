const gymConfig = require('../config/gymConfig');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Fixed answers for common questions, so they cost nothing and arrive instantly.
 * Covers English, Hinglish (romanised) and Kannada (script or romanised).
 * Info answers (hours, location, prices) only fire on short messages; longer
 * messages usually ask several things and go to the AI.
 */

// Reply buttons (max 3, titles max 20 chars). A tap comes back as the title and matches a route below.
const BUTTONS = {
  prices: { id: 'prices', title: 'Prices' },
  trial: { id: 'trial', title: 'Book a trial' },
  location: { id: 'location', title: 'Location' },
  coach: { id: 'coach', title: 'Talk to a coach' }
};

/** Buttons with the business type's words (gym: "Book a trial", others: "Book a visit"...). */
function buttonsFor(w) {
  return {
    prices: BUTTONS.prices,
    location: BUTTONS.location,
    trial: { id: 'trial', title: w.bookButton || BUTTONS.trial.title },
    coach: { id: 'coach', title: w.staffButton || BUTTONS.coach.title }
  };
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

const SHORT_MESSAGE_WORDS = 8;

const KANNADA_SCRIPT = /[ಀ-೿]/;
const DEVANAGARI = /[ऀ-ॿ]/;
const ROMAN_KANNADA = /\b(yelli|elli|idira|idiya|eshtu|estu|bele|yavaga|hottige|beku|beda|maadi|madi|gottilla|swalpa|namaskara|heli|helthira)\b/;
const HINGLISH = /\b(kya|hai|hain|kitna|kitni|kitne|kahan|kaha|kidhar|batao|bataiye|bataye|chahiye|mujhe|aap|karna|lagega|baje|kab|kaise|bhai|ji)\b/;

/** 'kn', 'hi' (Hinglish) or 'en'. */
function detectLanguage(text) {
  if (KANNADA_SCRIPT.test(text) || ROMAN_KANNADA.test(text)) return 'kn';
  if (HINGLISH.test(text)) return 'hi';
  return 'en';
}

const has = (text, patterns) => patterns.some(p => (p instanceof RegExp ? p.test(text) : text.includes(p)));

const ROUTES = {
  greeting: [/^(hi+|hello+|hey+|hlo|helo|namaste|namaskar|namaskara|ನಮಸ್ಕಾರ|good (morning|afternoon|evening)|hi there|hello there)[\s!.]*$/],
  deletion: [/\bdelete (my )?data\b/, /\bdelete my (number|details|info)\b/, /\bremove my (data|number|details)\b/],
  human: [
    'talk to human', 'speak to a person', 'speak to someone', 'call me', 'customer support', 'human agent',
    'human staff', 'connect to coach', 'speak to manager', 'connect me to', 'real person', 'speak to staff',
    'talk to a coach', 'talk to coach', 'talk to us', 'talk to the team', 'talk to advisor', 'property advisor', 'talk to someone', 'baat karni hai', 'baat karna hai', 'call karo', 'call kariye',
    'manager se baat', 'ಕರೆ ಮಾಡಿ', 'call maadi', 'call madi'
  ],
  complaint: ['complaint', 'dirty', 'broken', 'not working', 'unacceptable', 'rude', 'hygiene', 'shikayat', 'ganda'],
  trial: [
    'book a trial', 'book trial', 'trial session', 'free trial', 'try a workout', 'first workout free',
    'book free trial', 'book a visit', 'book visit', 'book site visit', 'site visit', 'book an appointment', 'book appointment', 'trial chahiye', 'trial lena', 'trial book', 'trial beku', 'ಟ್ರಯಲ್'
  ],
  hours: [
    'what time do you open', 'opening hours', 'gym timing', 'working hours', 'operating hours', 'close time',
    'closing time', 'sunday timing', /\btimings?\b/, 'kitne baje', 'kab khulta', 'kab khulega', 'kab tak khula',
    'yavaga open', 'hottige', 'samaya', 'ಸಮಯ', 'ಟೈಮಿಂಗ್', 'ಗಂಟೆ', /\bopen (today|now|on sunday)\b/
  ],
  location: [
    'where are you located', 'where is the gym', 'gym address', 'your location', 'location please', 'send location',
    'where is it located', 'parking', /^location\??$/, /\baddress\b/, 'kahan hai', 'kaha hai', 'kidhar hai',
    'kahan par', 'yelli ide', 'elli ide', 'yelli idira', 'ವಿಳಾಸ', 'ಎಲ್ಲಿ', 'ಲೊಕೇಶನ್'
  ],
  prices: [
    /\bprices?\b/, /\bpricing\b/, /\bfees?\b/, /\bcost\b/, /\bcharges\b/, 'membership plan', 'membership cost',
    'how much is', 'how much for', 'kitna hai', 'kitne ka', 'kitni fees', 'kitna lagega', 'kitne paise',
    /\bbele\b/, /\beshtu\b/, /\bestu\b/, 'ಬೆಲೆ', 'ಶುಲ್ಕ', 'ಎಷ್ಟು'
  ],
  // Discounts and negotiation go to the AI, which hands them to staff.
  negotiation: [/\bdiscount/, /\boffers?\b/, /negotiat/, /\bcheaper\b/, /\bkam (karo|kar do|ho)/, /\bconcession\b/, /\bkadime\b/, 'ಕಡಿಮೆ']
};

// Plain, short Indian English. A question only where it qualifies the lead (goal or timing) or books the visit.
const T = {
  greeting: {
    en: (g, w) => `Hi, welcome to ${g}! Tap a button below for prices, ${w.visit.enA} or our location. Or just type your question here.`,
    hi: (g, w) => `Hi, ${g} mein welcome! Neeche button tap karke prices, ${w.visit.hi} ya location dekh lo. Ya apna sawaal yahin type karo.`,
    kn: (g, w) => `ನಮಸ್ಕಾರ, ${g} ಗೆ ಸ್ವಾಗತ! ಬೆಲೆ, ${w.visit.kn} ಅಥವಾ ಲೊಕೇಶನ್‌ಗಾಗಿ ಕೆಳಗಿನ ಬಟನ್ ಒತ್ತಿ. ಅಥವಾ ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಇಲ್ಲೇ ಟೈಪ್ ಮಾಡಿ.`
  },
  hours: {
    en: (g, lines) => `${g} timings:\n${lines}\n\nMorning or evening works better for you?`,
    hi: (g, lines) => `${g} ki timings:\n${lines}\n\nAapke liye morning better hai ya evening?`,
    kn: (g, lines) => `${g} ಸಮಯ:\n${lines}\n\nನಿಮಗೆ ಬೆಳಿಗ್ಗೆ ಅನುಕೂಲವೋ ಸಂಜೆಯೋ?`
  },
  location: {
    en: (loc, park, w) => `We're at ${loc}. ${park}.\n\nIf you want to come for ${w.visit.enA}, just tell us the day and ${w.staff.en} will confirm.`,
    hi: (loc, park, w) => `Hum yahan hain: ${loc}. ${park}.\n\n${cap(w.visit.hi)} ke liye aana ho toh bas din bata do, ${w.staff.hi} confirm kar ${w.staff.hiWill}.`,
    kn: (loc, park, w) => `ನಮ್ಮ ವಿಳಾಸ: ${loc}. ${park}.\n\n${w.visit.kn}‌ಗೆ ಬರಬೇಕಾದರೆ ದಿನ ತಿಳಿಸಿ, ${w.staff.kn} ಖಚಿತಪಡಿಸುತ್ತಾರೆ.`
  },
  prices: {
    en: (g, list, w) => `${g} ${w.plans.en}:\n${list}\n\n${w.pricesAsk.en}`,
    hi: (g, list, w) => `${g} ke ${w.plans.hi}:\n${list}\n\n${w.pricesAsk.hi}`,
    kn: (g, list, w) => `${g} ${w.plans.kn}:\n${list}\n\n${w.pricesAsk.kn}`
  },
  deletion: {
    en: () => "Got it. We'll delete your details and chat history within 30 days and confirm here when it's done.",
    hi: () => 'Theek hai. Hum 30 din ke andar aapki details aur chat history delete karke yahin confirm kar denge.',
    kn: () => 'ಸರಿ. 30 ದಿನಗಳ ಒಳಗೆ ನಿಮ್ಮ ವಿವರಗಳು ಮತ್ತು ಚಾಟ್ ಇತಿಹಾಸವನ್ನು ಅಳಿಸಿ ಇಲ್ಲೇ ಖಚಿತಪಡಿಸುತ್ತೇವೆ.'
  },
  human: {
    en: w => `Sure, I've told our team. ${cap(w.staff.en)} will call or message you shortly.`,
    hi: w => `Done, maine team ko bata diya hai. ${cap(w.staff.hi)} aapko jaldi call ya message karenge.`,
    kn: w => `ಸರಿ, ತಂಡಕ್ಕೆ ತಿಳಿಸಿದ್ದೇನೆ. ${w.staff.kn} ಶೀಘ್ರದಲ್ಲೇ ಕರೆ ಅಥವಾ ಮೆಸೇಜ್ ಮಾಡುತ್ತಾರೆ.`
  },
  complaint: {
    en: () => "Really sorry about this. I've passed it to our manager and they will contact you directly.",
    hi: () => 'Iske liye sorry. Maine manager ko bata diya hai, woh aapse seedha baat karenge.',
    kn: () => 'ಇದಕ್ಕಾಗಿ ಕ್ಷಮಿಸಿ. ಮ್ಯಾನೇಜರ್‌ಗೆ ತಿಳಿಸಿದ್ದೇನೆ, ಅವರು ನಿಮ್ಮನ್ನು ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸುತ್ತಾರೆ.'
  },
  trial: {
    en: w => `Sure, let's get you in for ${w.visit.enA}. Which day and time suit you? ${cap(w.staff.en)} will message you to confirm.`,
    hi: w => `Bilkul, ${w.visit.hi} book karte hain. Kaunsa din aur time theek rahega? ${cap(w.staff.hi)} message karke confirm kar ${w.staff.hiWill}.`,
    kn: w => `ಖಂಡಿತ, ${w.visit.kn} ಬುಕ್ ಮಾಡೋಣ. ಯಾವ ದಿನ ಮತ್ತು ಸಮಯ ಅನುಕೂಲ? ${w.staff.kn} ಮೆಸೇಜ್ ಮಾಡಿ ಖಚಿತಪಡಿಸುತ್ತಾರೆ.`
  }
};

/** Map pin: from the business profile, else GYM_LATITUDE / GYM_LONGITUDE (env names kept for existing deployments). */
function gymLocation(cfg) {
  const pin = cfg.mapPin || (Number.isFinite(env.gymLatitude) && Number.isFinite(env.gymLongitude)
    ? { latitude: env.gymLatitude, longitude: env.gymLongitude } : null);
  if (!pin) return null;
  return { ...pin, name: cfg.gymName, address: cfg.facility.location };
}

class DeterministicRouter {
  /**
   * Returns a fixed reply when the message clearly matches a common intent.
   * @returns {{ matched: boolean, intent?: string, replyText?: string, updates?: object, buttons?: object[], location?: object }}
   */
  routeMessage(text = '', tenantConfig = {}, lead = {}) {
    const clean = String(text || '').toLowerCase().trim();
    if (!clean) return { matched: false };
    // Hindi in Devanagari goes to the AI, which replies in Hindi.
    if (DEVANAGARI.test(clean)) return { matched: false };

    const cfg = { ...gymConfig, ...tenantConfig };
    const g = cfg.gymName;
    const w = (cfg.vertical || gymConfig.vertical).words;
    const B = buttonsFor(w);
    const lang = detectLanguage(clean);
    const short = clean.split(/\s+/).length <= SHORT_MESSAGE_WORDS;
    const hit = (intent, extra) => {
      logger.debug('Fixed reply matched', { intent, lang, wa_id: lead.wa_id });
      return { matched: true, intent, ...extra };
    };

    // First "hi" from a new lead gets the welcome menu. Later greetings go to the AI, which knows the context.
    if (has(clean, ROUTES.greeting) && !lead.last_outbound_message_at) {
      return hit('greeting', {
        replyText: T.greeting[lang](g, w),
        updates: { status: 'contacted' },
        buttons: [B.prices, B.trial, B.location]
      });
    }

    // Privacy: data deletion requests go straight to staff (see /data-deletion and scripts/delete-lead.js).
    if (has(clean, ROUTES.deletion)) {
      return hit('deletion', {
        replyText: T.deletion[lang](),
        updates: { needs_human: true, handoff_reason: 'other', summary: 'DATA DELETION REQUEST: delete this lead within 30 days (npm run delete-lead).' }
      });
    }

    if (has(clean, ROUTES.human)) {
      return hit('human', {
        replyText: T.human[lang](w),
        updates: { needs_human: true, handoff_reason: 'human_requested', summary: 'Lead asked to talk to staff.' }
      });
    }

    if (has(clean, ROUTES.complaint)) {
      return hit('complaint', {
        replyText: T.complaint[lang](),
        updates: { needs_human: true, handoff_reason: 'complaint', summary: 'Lead reported a facility or service complaint.' }
      });
    }

    if (has(clean, ROUTES.trial)) {
      return hit('trial', {
        replyText: T.trial[lang](w),
        updates: { interest: 'trial_booking', status: 'hot', needs_human: true, handoff_reason: 'ready_to_book', summary: `Lead asked to book ${w.visit.enA}.` }
      });
    }

    if (!short) return { matched: false };

    if (has(clean, ROUTES.hours)) {
      return hit('hours', {
        replyText: T.hours[lang](g, (cfg.hours.lines || [cfg.hours.weekday, cfg.hours.sunday]).filter(Boolean).map(h => `• ${h}`).join('\n')),
        updates: { status: 'contacted' },
        buttons: [B.trial, B.location, B.prices]
      });
    }

    if (has(clean, ROUTES.location)) {
      return hit('location', {
        replyText: T.location[lang](cfg.facility.location, cfg.facility.parking, w),
        updates: { status: 'contacted' },
        location: gymLocation(cfg),
        buttons: [B.trial, B.prices]
      });
    }

    if (has(clean, ROUTES.prices) && !has(clean, ROUTES.negotiation)) {
      const list = cfg.pricingTiers.map(t => `• ${t.name}: ${t.price}`).join('\n');
      return hit('prices', {
        replyText: T.prices[lang](g, list, w),
        updates: { interest: 'membership_pricing', status: 'qualified' },
        buttons: [B.trial, B.coach]
      });
    }

    return { matched: false };
  }
}

module.exports = new DeterministicRouter();
module.exports.DeterministicRouter = DeterministicRouter;
module.exports.detectLanguage = detectLanguage;
module.exports.BUTTONS = BUTTONS;
