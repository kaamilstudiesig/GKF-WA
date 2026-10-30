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
    'talk to a coach', 'talk to coach', 'baat karni hai', 'baat karna hai', 'call karo', 'call kariye',
    'manager se baat', 'ಕರೆ ಮಾಡಿ', 'call maadi', 'call madi'
  ],
  complaint: ['complaint', 'dirty', 'broken', 'not working', 'unacceptable', 'rude', 'hygiene', 'shikayat', 'ganda'],
  trial: [
    'book a trial', 'book trial', 'trial session', 'free trial', 'try a workout', 'first workout free',
    'book free trial', 'trial chahiye', 'trial lena', 'trial book', 'trial beku', 'ಟ್ರಯಲ್'
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
    en: g => `Hi, welcome to ${g}! Tap a button below for prices, a trial or our location. Or just type your question here.`,
    hi: g => `Hi, ${g} mein welcome! Neeche button tap karke prices, trial ya location dekh lo. Ya apna sawaal yahin type karo.`,
    kn: g => `ನಮಸ್ಕಾರ, ${g} ಗೆ ಸ್ವಾಗತ! ಬೆಲೆ, ಟ್ರಯಲ್ ಅಥವಾ ಲೊಕೇಶನ್‌ಗಾಗಿ ಕೆಳಗಿನ ಬಟನ್ ಒತ್ತಿ. ಅಥವಾ ನಿಮ್ಮ ಪ್ರಶ್ನೆಯನ್ನು ಇಲ್ಲೇ ಟೈಪ್ ಮಾಡಿ.`
  },
  hours: {
    en: (g, w, s) => `${g} timings:\n• ${w}\n• ${s}\n\nMorning or evening works better for you?`,
    hi: (g, w, s) => `${g} ki timings:\n• ${w}\n• ${s}\n\nAapke liye morning better hai ya evening?`,
    kn: (g, w, s) => `${g} ಸಮಯ:\n• ${w}\n• ${s}\n\nನಿಮಗೆ ಬೆಳಿಗ್ಗೆ ಅನುಕೂಲವೋ ಸಂಜೆಯೋ?`
  },
  location: {
    en: (loc, park) => `We're at ${loc}. ${park}.\n\nIf you want to come for a trial, just tell us the day and a coach will confirm.`,
    hi: (loc, park) => `Hum yahan hain: ${loc}. ${park}.\n\nTrial ke liye aana ho toh bas din bata do, coach confirm kar dega.`,
    kn: (loc, park) => `ನಮ್ಮ ವಿಳಾಸ: ${loc}. ${park}.\n\nಟ್ರಯಲ್‌ಗೆ ಬರಬೇಕಾದರೆ ದಿನ ತಿಳಿಸಿ, ಕೋಚ್ ಖಚಿತಪಡಿಸುತ್ತಾರೆ.`
  },
  prices: {
    en: (g, list) => `${g} membership plans:\n${list}\n\nLonger plans work out cheaper per month. What's your main goal, fat loss or muscle? I'll tell you which plan fits.`,
    hi: (g, list) => `${g} ke membership plans:\n${list}\n\nLamba plan per month sasta padta hai. Aapka main goal kya hai, fat loss ya muscle?`,
    kn: (g, list) => `${g} ಸದಸ್ಯತ್ವ ಯೋಜನೆಗಳು:\n${list}\n\nದೀರ್ಘ ಯೋಜನೆ ತಿಂಗಳಿಗೆ ಕಡಿಮೆ ಬೀಳುತ್ತದೆ. ನಿಮ್ಮ ಮುಖ್ಯ ಗುರಿ ಏನು, ತೂಕ ಇಳಿಕೆಯೋ ಮಸಲ್ ಬೆಳವಣಿಗೆಯೋ?`
  },
  deletion: {
    en: () => "Got it. We'll delete your details and chat history within 30 days and confirm here when it's done.",
    hi: () => 'Theek hai. Hum 30 din ke andar aapki details aur chat history delete karke yahin confirm kar denge.',
    kn: () => 'ಸರಿ. 30 ದಿನಗಳ ಒಳಗೆ ನಿಮ್ಮ ವಿವರಗಳು ಮತ್ತು ಚಾಟ್ ಇತಿಹಾಸವನ್ನು ಅಳಿಸಿ ಇಲ್ಲೇ ಖಚಿತಪಡಿಸುತ್ತೇವೆ.'
  },
  human: {
    en: () => "Sure, I've told our team. A coach will call or message you shortly.",
    hi: () => 'Done, maine team ko bata diya hai. Coach aapko jaldi call ya message karenge.',
    kn: () => 'ಸರಿ, ತಂಡಕ್ಕೆ ತಿಳಿಸಿದ್ದೇನೆ. ಕೋಚ್ ಶೀಘ್ರದಲ್ಲೇ ಕರೆ ಅಥವಾ ಮೆಸೇಜ್ ಮಾಡುತ್ತಾರೆ.'
  },
  complaint: {
    en: () => "Really sorry about this. I've passed it to our manager and they will contact you directly.",
    hi: () => 'Iske liye sorry. Maine manager ko bata diya hai, woh aapse seedha baat karenge.',
    kn: () => 'ಇದಕ್ಕಾಗಿ ಕ್ಷಮಿಸಿ. ಮ್ಯಾನೇಜರ್‌ಗೆ ತಿಳಿಸಿದ್ದೇನೆ, ಅವರು ನಿಮ್ಮನ್ನು ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸುತ್ತಾರೆ.'
  },
  trial: {
    en: () => "Sure, let's get you in for a trial. Which day and time suit you? A coach will message you to confirm.",
    hi: () => 'Bilkul, trial book karte hain. Kaunsa din aur time theek rahega? Coach message karke confirm kar dega.',
    kn: () => 'ಖಂಡಿತ, ಟ್ರಯಲ್ ಬುಕ್ ಮಾಡೋಣ. ಯಾವ ದಿನ ಮತ್ತು ಸಮಯ ಅನುಕೂಲ? ಕೋಚ್ ಮೆಸೇಜ್ ಮಾಡಿ ಖಚಿತಪಡಿಸುತ್ತಾರೆ.'
  }
};

/** Map pin for the gym, when coordinates are configured. */
function gymLocation(cfg) {
  if (!Number.isFinite(env.gymLatitude) || !Number.isFinite(env.gymLongitude)) return null;
  return { latitude: env.gymLatitude, longitude: env.gymLongitude, name: cfg.gymName, address: cfg.facility.location };
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
    const lang = detectLanguage(clean);
    const short = clean.split(/\s+/).length <= SHORT_MESSAGE_WORDS;
    const hit = (intent, extra) => {
      logger.debug('Fixed reply matched', { intent, lang, wa_id: lead.wa_id });
      return { matched: true, intent, ...extra };
    };

    // First "hi" from a new lead gets the welcome menu. Later greetings go to the AI, which knows the context.
    if (has(clean, ROUTES.greeting) && !lead.last_outbound_message_at) {
      return hit('greeting', {
        replyText: T.greeting[lang](g),
        updates: { status: 'contacted' },
        buttons: [BUTTONS.prices, BUTTONS.trial, BUTTONS.location]
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
        replyText: T.human[lang](),
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
        replyText: T.trial[lang](),
        updates: { interest: 'trial_booking', status: 'hot', needs_human: true, handoff_reason: 'ready_to_book', summary: 'Lead asked to book a trial.' }
      });
    }

    if (!short) return { matched: false };

    if (has(clean, ROUTES.hours)) {
      return hit('hours', {
        replyText: T.hours[lang](g, cfg.hours.weekday, cfg.hours.sunday),
        updates: { status: 'contacted' },
        buttons: [BUTTONS.trial, BUTTONS.location, BUTTONS.prices]
      });
    }

    if (has(clean, ROUTES.location)) {
      return hit('location', {
        replyText: T.location[lang](cfg.facility.location, cfg.facility.parking),
        updates: { status: 'contacted' },
        location: gymLocation(cfg),
        buttons: [BUTTONS.trial, BUTTONS.prices]
      });
    }

    if (has(clean, ROUTES.prices) && !has(clean, ROUTES.negotiation)) {
      const list = cfg.pricingTiers.map(t => `• ${t.name}: ${t.price}`).join('\n');
      return hit('prices', {
        replyText: T.prices[lang](g, list),
        updates: { interest: 'membership_pricing', status: 'qualified' },
        buttons: [BUTTONS.trial, BUTTONS.coach]
      });
    }

    return { matched: false };
  }
}

module.exports = new DeterministicRouter();
module.exports.DeterministicRouter = DeterministicRouter;
module.exports.detectLanguage = detectLanguage;
module.exports.BUTTONS = BUTTONS;
