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

const T = {
  greeting: {
    en: g => `Welcome to ${g}! 💪 I can share our membership prices, help you book a trial, or send our location. What would you like?`,
    hi: g => `${g} mein aapka swagat hai! 💪 Main aapko membership prices bata sakta hoon, trial book karwa sakta hoon, ya location bhej sakta hoon. Kya chahiye?`,
    kn: g => `${g} ಗೆ ಸ್ವಾಗತ! 💪 ಸದಸ್ಯತ್ವ ಬೆಲೆಗಳು, ಟ್ರಯಲ್ ಬುಕಿಂಗ್ ಅಥವಾ ನಮ್ಮ ಲೊಕೇಶನ್ — ಏನು ಬೇಕು?`
  },
  hours: {
    en: (g, w, s) => `${g} operating hours:\n• ${w}\n• ${s}\n\nWhen would you like to drop by for a workout or facility tour?`,
    hi: (g, w, s) => `${g} ki timings:\n• ${w}\n• ${s}\n\nAap workout ya gym tour ke liye kab aana chahenge?`,
    kn: (g, w, s) => `${g} ಸಮಯ:\n• ${w}\n• ${s}\n\nವರ್ಕೌಟ್ ಅಥವಾ ಜಿಮ್ ನೋಡಲು ಯಾವಾಗ ಬರುತ್ತೀರಿ?`
  },
  location: {
    en: (loc, park) => `We are located at: ${loc}.\n\nParking: ${park}.\n\nAre you looking to visit for a personal consultation or trial session?`,
    hi: (loc, park) => `Hum yahan hain: ${loc}.\n\nParking: ${park}.\n\nKya aap consultation ya trial session ke liye aana chahenge?`,
    kn: (loc, park) => `ನಮ್ಮ ವಿಳಾಸ: ${loc}.\n\nಪಾರ್ಕಿಂಗ್: ${park}.\n\nಕನ್ಸಲ್ಟೇಶನ್ ಅಥವಾ ಟ್ರಯಲ್ ಸೆಷನ್‌ಗೆ ಬರುತ್ತೀರಾ?`
  },
  prices: {
    en: (g, list) => `${g} membership plans:\n${list}\n\nWhat's your main goal? I'll suggest the right plan.`,
    hi: (g, list) => `${g} ke membership plans:\n${list}\n\nAapka main goal kya hai? Main sahi plan suggest kar deta hoon.`,
    kn: (g, list) => `${g} ಸದಸ್ಯತ್ವ ಯೋಜನೆಗಳು:\n${list}\n\nನಿಮ್ಮ ಮುಖ್ಯ ಗುರಿ ಏನು? ಸರಿಯಾದ ಯೋಜನೆ ಸೂಚಿಸುತ್ತೇನೆ.`
  },
  human: {
    en: g => `Understood! I've notified our coaching team at ${g}. A senior staff member will reach out to you shortly.`,
    hi: g => `Theek hai! Maine ${g} ki coaching team ko bata diya hai. Hamare staff se koi aapko jaldi contact karega.`,
    kn: g => `ಸರಿ! ${g} ಕೋಚಿಂಗ್ ತಂಡಕ್ಕೆ ತಿಳಿಸಿದ್ದೇನೆ. ನಮ್ಮ ಸಿಬ್ಬಂದಿ ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತಾರೆ.`
  },
  complaint: {
    en: g => `We sincerely apologize for this experience. We take facility standards very seriously at ${g}. Our management has been notified and will contact you directly.`,
    hi: g => `Is experience ke liye hum maafi chahte hain. ${g} mein hum standards ko bahut seriously lete hain. Management ko bata diya gaya hai, woh aapse seedha contact karenge.`,
    kn: g => `ಈ ಅನುಭವಕ್ಕಾಗಿ ಕ್ಷಮಿಸಿ. ${g} ನಲ್ಲಿ ನಾವು ಗುಣಮಟ್ಟವನ್ನು ಗಂಭೀರವಾಗಿ ಪರಿಗಣಿಸುತ್ತೇವೆ. ಮ್ಯಾನೇಜ್‌ಮೆಂಟ್‌ಗೆ ತಿಳಿಸಲಾಗಿದೆ, ಅವರು ನಿಮ್ಮನ್ನು ನೇರವಾಗಿ ಸಂಪರ್ಕಿಸುತ್ತಾರೆ.`
  },
  trial: {
    en: () => 'You can book an introductory trial session with us! A coach will message you shortly to confirm. Which day and time works best for you?',
    hi: () => 'Aap hamare saath trial session book kar sakte hain! Ek coach aapko jaldi message karke confirm karega. Aapke liye kaunsa din aur time theek rahega?',
    kn: () => 'ನೀವು ನಮ್ಮೊಂದಿಗೆ ಟ್ರಯಲ್ ಸೆಷನ್ ಬುಕ್ ಮಾಡಬಹುದು! ಕೋಚ್ ಶೀಘ್ರದಲ್ಲೇ ಮೆಸೇಜ್ ಮಾಡಿ ಖಚಿತಪಡಿಸುತ್ತಾರೆ. ನಿಮಗೆ ಯಾವ ದಿನ ಮತ್ತು ಸಮಯ ಅನುಕೂಲ?'
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

    if (has(clean, ROUTES.human)) {
      return hit('human', {
        replyText: T.human[lang](g),
        updates: { needs_human: true, handoff_reason: 'human_requested', summary: 'Lead asked to talk to staff.' }
      });
    }

    if (has(clean, ROUTES.complaint)) {
      return hit('complaint', {
        replyText: T.complaint[lang](g),
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
