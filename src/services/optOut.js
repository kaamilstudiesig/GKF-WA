/**
 * K30 opt-out. A lead who writes STOP, UNSUBSCRIBE or "don't message me" (English,
 * Hinglish/Hindi, Kannada, Arabic) is marked opted out (`leads.opted_out_at`):
 * - they get one fixed confirmation (no AI call);
 * - template messages to them are refused (whatsappService.sendTemplate), since a
 *   template is how a business messages someone who hasn't written in 24 hours;
 * - START, or a new message from them, turns it off again (they started the chat). A short
 *   acknowledgement ("ok", "thanks", 👍) right after STOP doesn't: it keeps the opt-out and gets no reply.
 *
 * Matching is strict on purpose: only a short message that is the keyword, or a clear
 * "stop messaging me" phrase. "Can you stop by tomorrow?" is not an opt-out.
 */
const ARABIC = /[؀-ۿ]/;
const KANNADA = /[ಀ-೿]/;
const DEVANAGARI = /[ऀ-ॿ]/;

const clean = text => String(text || '').toLowerCase().normalize('NFKC')
  .replace(/[’`]/g, "'").replace(/[^\p{L}\p{M}\p{N}'\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Whole-message keywords (after cleaning).
const STOP_WORDS = new Set([
  'stop', 'stop it', 'stop all', 'unsubscribe', 'unsub', 'opt out', 'optout', 'cancel subscription',
  'stop messages', 'stop messaging', 'stop msg', 'stop msgs', 'stop sending', 'no more messages',
  // Hindi / Hinglish
  'band karo', 'message band karo', 'msg band karo', 'बंद करो', 'मैसेज बंद करो',
  'mat bhejo', 'na bhejo', 'मत भेजो',
  'msg mt kro', 'msg mat bhejiye', 'message band kar do', 'मैसेज मत भेजिए', 'मैसेज नहीं चाहिए',
  // Kannada
  'ನಿಲ್ಲಿಸಿ', 'ನಿಲ್ಲಿಸು',
  'ನನಗೆ ಮೆಸೇಜ್ ಬೇಡ', 'ಸಂದೇಶಗಳನ್ನು ಕಳುಹಿಸಬೇಡಿ', 'ಮೆಸೇಜ್ ಕಳಿಸ್ಬೇಡಿ',
  'nanage message beda', 'message kalisabedi', 'msg maadabedi',
  // Arabic
  'توقف', 'قف', 'الغاء الاشتراك', 'إلغاء الاشتراك',
  'ما أبي رسايل', 'ما أبغى رسائل', 'وقفوا الرسايل', 'شيلوني من القائمة', 'لا عاد ترسل'
]);
const START_WORDS = new Set(['start', 'subscribe', 'resume', 'unstop', 'ابدأ', 'اشتراك', 'ಪ್ರಾರಂಭಿಸಿ']);

// Phrases that may sit inside a short message ("please don't message me again").
const STOP_PHRASES = [
  /\b(don'?t|do not|dont|pls don'?t|please don'?t|never) (message|msg|text|whatsapp|contact|send) me\b/,
  /\bstop (messaging|texting|sending|contacting|msging) (me|us)\b/,
  /\bstop (sending )?(me )?(these |your |any )?(messages|msgs|texts|promotions|offers)\b/,
  /\b(remove|delete) me from (your |the )?(list|contacts|broadcast|whatsapp list)\b/,
  /\bunsubscribe me\b/, /\bopt me out\b/, /\bnot interested,? (don'?t|do not) (message|contact)\b/,
  // Hinglish
  /\b(mujhe |muje )?(message|msg|messages|whatsapp) (mat|na) (karo|kro|karna|bhejo|bhejna|kijiye)\b/,
  /\bmessage (bhejna )?band karo\b/,
  // Hindi
  /(मुझे )?(मैसेज|संदेश) (मत|ना) (करो|भेजो|भेजें|कीजिए)/,
  // Kannada
  /(ಮೆಸೇಜ್|ಸಂದೇಶ) (ಮಾಡಬೇಡಿ|ಕಳುಹಿಸಬೇಡಿ|ಕಳಿಸಬೇಡಿ)/, /(message|msg) (madbedi|maadbedi|kalisbedi)/,
  // Arabic
  /(لا|لاتـ?) ?(ترسل|ترسلوا) (لي|رسائل|رسايل|رسالة)(?= |$)/,
  /(لا|لاتـ?) ?(تراسلني|تراسلوني)/, /توقفوا عن (الارسال|الإرسال|مراسلتي)/
];

const MAX_PHRASE_WORDS = 12;

// Short closes that don't mean "talk to me again" (often a reply to our STOP confirmation).
const ACK_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'ok thanks', 'ok thank you', 'okay thanks', 'thanks', 'thank you', 'thanku', 'thank u',
  'thx', 'ty', 'tq', 'fine', 'done', 'sure', 'alright', 'got it', 'noted', 'cool', 'great', 'good', 'np',
  'theek hai', 'thik hai', 'theek', 'achha', 'acha', 'shukriya', 'dhanyavad', 'dhanyawad',
  'ಸರಿ', 'ಧನ್ಯವಾದ', 'ಧನ್ಯವಾದಗಳು', 'sari', 'thanks sir', 'شكرا', 'شكراً', 'تمام', 'حسنا', 'ok sir', 'ok mam', 'ok madam'
]);

/** True for a bare acknowledgement: "ok", "thanks", an emoji or punctuation only. */
function isAcknowledgement(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const t = clean(raw);
  if (!t) return true; // only emoji or punctuation (👍, 🙏, "."), no words
  return ACK_WORDS.has(t);
}

/** 'stop', 'start' or null for one inbound message. */
function classify(text) {
  const t = clean(text);
  if (!t) return null;
  if (STOP_WORDS.has(t)) return 'stop';
  if (START_WORDS.has(t)) return 'start';
  if (t.split(' ').length <= MAX_PHRASE_WORDS && STOP_PHRASES.some(re => re.test(t))) return 'stop';
  return null;
}

function languageOf(text) {
  const raw = String(text || '');
  if (ARABIC.test(raw)) return 'ar';
  if (KANNADA.test(raw) || /\b(madbedi|maadbedi|kalisbedi|beda|kalisabedi|maadabedi)\b/i.test(raw)) return 'kn';
  if (DEVANAGARI.test(raw) || /\b(mat|band kar(?:o| do)|bhejo|karo|kro|mujhe|muje)\b/i.test(raw)) return 'hi';
  return 'en';
}

const REPLIES = {
  stop: {
    en: "Okay, we won't message you again. If you write to us later, we'll reply.",
    hi: 'Theek hai, hum aapko aage message nahi karenge. Aap kabhi bhi message karein, hum reply karenge.',
    kn: 'ಸರಿ, ನಾವು ಇನ್ನು ಮುಂದೆ ನಿಮಗೆ ಸಂದೇಶ ಕಳುಹಿಸುವುದಿಲ್ಲ. ನೀವು ಮತ್ತೆ ಬರೆದರೆ ನಾವು ಉತ್ತರಿಸುತ್ತೇವೆ.',
    ar: 'حسنًا، لن نرسل لك رسائل بعد الآن. إذا راسلتنا لاحقًا سنرد عليك.'
  },
  start: {
    en: "Welcome back. You'll get our messages again. How can we help?",
    hi: 'Welcome back. Aapko hamare messages phir se milenge. Hum kaise madad kar sakte hain?',
    kn: 'ಮತ್ತೆ ಸ್ವಾಗತ. ನಿಮಗೆ ನಮ್ಮ ಸಂದೇಶಗಳು ಮತ್ತೆ ಬರುತ್ತವೆ. ನಾವು ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?',
    ar: 'أهلًا بعودتك. ستصلك رسائلنا مرة أخرى. كيف يمكننا مساعدتك؟'
  }
};

const replyFor = (kind, text) => REPLIES[kind][languageOf(text)];

class OptedOutError extends Error {
  constructor() {
    super('This lead opted out (STOP): template messages are not sent to them.');
    this.name = 'OptedOutError';
    this.optedOut = true;
  }
}

module.exports = { classify, isAcknowledgement, replyFor, languageOf, OptedOutError, REPLIES };
