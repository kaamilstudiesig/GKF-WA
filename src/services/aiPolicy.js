const logger = require('../utils/logger');

const ALLOWED_AI_STATUSES = ['new', 'contacted', 'qualified', 'hot', 'cold', 'lost'];
const ALLOWED_HANDOFF_REASONS = [
  'ready_to_book',
  'price_negotiation',
  'custom_program',
  'injury_question',
  'human_requested',
  'complaint',
  'rate_limit_exceeded',
  'ai_service_unavailable',
  'ai_network_error',
  'budget_exceeded',
  'other'
];

// K33 health mode. A message is a health question when it has a symptom or advice-seeking phrase
// (STRONG), or a condition or medicine word together with a personal marker ("my", "I have",
// "mujhe"...). So "How much is a blood test?" or "medicine price list" still reach the assistant,
// while "my sugar is 300, which tablet?" goes to staff. English, Hinglish, Hindi, Kannada, Arabic.
const HEALTH_STRONG = [
  /\b(pain|pains|painful|ache|aches|aching|hurts?|hurting|sore|fever|bleeding|swelling|swollen|rash|itch(ing|y)?|infection|infected|pus|dizzy|dizziness|faint(ed|ing)?|vomit(ing)?|nausea|cough(ing)?|breathless(ness)?|short of breath|breathing (problem|difficulty|trouble)|numb(ness)?|tingling|headache|migraine|lump|sprain|fracture|injury|injured|side effects?|symptoms?|diagnos\w*|allergic reaction)\b/,
  /\b(is it safe|safe for me|what should i do|is this normal|is it normal|how do i (fix|treat|cure)|how (much|many) (mg|milligrams?|tablets|pills|doses?))\b/, /\b\d+\s?mg\b/,
  /\b(dard|bukhar|bukhaar|khansi|sujan|chakkar|ulti|zukham|saans|sans lene|dikkat|takleef|takleef|bimar|beemar|tabiyat|tabiyet|kya karun|kya karoon|kya karu)\b/,
  /(दर्द|बुखार|खांसी|खाँसी|सूजन|चक्कर|उल्टी|साँस|सांस|दिक्कत|तकलीफ|बीमार|तबीयत|क्या करूँ|क्या करूं|क्या करू)/,
  /(ನೋವು|ಜ್ವರ|ಊತ|ಕೆಮ್ಮು|ಉಸಿರ|ತಲೆನೋವು|ವಾಂತಿ|ತಲೆ ಸುತ್ತು|ಏನು ಮಾಡಲಿ)/,
  /(ألم|وجع|حمى|حرارة|نزيف|ضيق في التنفس|صعوبة في التنفس|دوخة|ماذا أفعل|حساسية|كحة|سعال)/
];
const HEALTH_TOPIC = [
  /\b(diabetes|diabetic|sugar|bp|blood pressure|blood|thyroid|asthma|cholesterol|pregnan(t|cy)|cancer|tumou?r|heart|stroke|epilepsy|depression|anxiety|medicines?|medications?|tablets?|pills?|doses?|dosage|prescription|injections?|antibiotics?|painkillers?|ibuprofen|paracetamol|dolo|crocin)\b/,
  /(दवा|दवाई|इलाज|खून|गर्भ|शुगर|बीपी)/, /(ಔಷಧ|ಮಾತ್ರೆ|ರಕ್ತ|ಸಕ್ಕರೆ|ಗರ್ಭ)/, /(دواء|علاج|حبوب|حامل|سكري|ضغط الدم|دم)/
];
const HEALTH_PERSONAL = [
  /\b(i have|i've|i had|i am|i'm|im|my|mine|myself|should i|can i (take|eat|use|drink)|is it ok|since (yesterday|morning|\d+)|for \d+ days|mujhe|mujhko|meri|mera|mere|maine|kya main|hu|hoon|hun)\b/,
  /(मुझे|मेरा|मेरी|मेरे|मैंने)/, /(ನನಗೆ|ನನ್ನ)/, /(عندي|لدي|أعاني|ابني|بنتي|زوجي|زوجتي)/
];
// In the assistant's own reply: anything that reads like advice (a health-mode safety net).
const ADVICE_RE = /\b(\d+\s?mg|milligrams?|dosage|twice a day|three times a day|you (may|might|could) have|it (could|might|may) be (a|an)|sounds like (a|an)|diagnos\w*|take (one|two|\d+) (tablet|pill)s?)\b/;
const HEALTH_REPLIES = {
  en: "Thanks for telling us. We can't give medical advice on WhatsApp, so a member of our team will get back to you personally. If it is urgent, please see a doctor or call emergency services.",
  hi: 'Batane ke liye shukriya. Hum WhatsApp par medical salah nahi de sakte, isliye hamari team ka koi member aapse khud baat karega. Agar emergency hai, toh turant doctor se milein ya emergency number par call karein.',
  kn: 'ತಿಳಿಸಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾವು WhatsApp ನಲ್ಲಿ ವೈದ್ಯಕೀಯ ಸಲಹೆ ನೀಡಲು ಸಾಧ್ಯವಿಲ್ಲ, ನಮ್ಮ ತಂಡದವರು ನಿಮ್ಮನ್ನು ಸಂಪರ್ಕಿಸುತ್ತಾರೆ. ತುರ್ತು ಇದ್ದರೆ, ದಯವಿಟ್ಟು ತಕ್ಷಣ ವೈದ್ಯರನ್ನು ಭೇಟಿ ಮಾಡಿ ಅಥವಾ ತುರ್ತು ಸಂಖ್ಯೆಗೆ ಕರೆ ಮಾಡಿ.',
  ar: 'شكرًا لإخبارنا. لا يمكننا تقديم نصيحة طبية عبر واتساب، وسيتواصل معك أحد أفراد فريقنا شخصيًا. إذا كان الأمر عاجلًا، يرجى مراجعة طبيب أو الاتصال بالطوارئ فورًا.'
};
// While a health hand-off is open, the assistant stays out of the chat.
const HEALTH_HOLD = {
  en: 'Thanks. Our team has your message and will reply to you soon.',
  hi: 'Shukriya. Hamari team ko aapka message mil gaya hai, woh jaldi aapko reply karenge.',
  kn: 'ಧನ್ಯವಾದಗಳು. ನಿಮ್ಮ ಸಂದೇಶ ನಮ್ಮ ತಂಡಕ್ಕೆ ತಲುಪಿದೆ, ಅವರು ಶೀಘ್ರದಲ್ಲೇ ಉತ್ತರಿಸುತ್ತಾರೆ.',
  ar: 'شكرًا. وصلت رسالتك إلى فريقنا وسيردون عليك قريبًا.'
};
const healthLang = text => require('./optOut').languageOf(text);

class AIPolicy {
  /**
   * Enforces business rules and validation on AI-proposed updates.
   * Invariant 5: AI can NEVER mark a lead as 'converted'.
   * Invariant 4: AI output must never directly bypass application validation.
   * @param {object} currentLead
   * @param {object} proposedUpdates
   * @returns {object} Validated, sanitized updates safe for CRM persistence
   */
  validateAndSanitizeUpdates(currentLead, proposedUpdates = {}) {
    const safeUpdates = {};

    // 1. Name validation
    if (proposedUpdates.name && typeof proposedUpdates.name === 'string') {
      const cleanName = proposedUpdates.name.trim().slice(0, 100);
      if (cleanName.length > 0 && (!currentLead.display_name || currentLead.display_name === 'Unknown')) {
        safeUpdates.display_name = cleanName;
      }
    }

    // 2. Interest validation
    if (proposedUpdates.interest && typeof proposedUpdates.interest === 'string') {
      safeUpdates.interest = proposedUpdates.interest.trim().slice(0, 150);
    }

    // 3. Status transition policy (Strict conversion protection)
    if (proposedUpdates.status && typeof proposedUpdates.status === 'string') {
      const targetStatus = proposedUpdates.status.toLowerCase().trim();

      if (targetStatus === 'converted') {
        logger.warn('AI attempt to mark lead as converted BLOCKED by policy layer', {
          wa_id: currentLead.wa_id,
          attempted_status: targetStatus
        });
        // Blocked: Conversion requires authorized staff action or verified booking/payment event
      } else if (ALLOWED_AI_STATUSES.includes(targetStatus)) {
        // Enforce progressive qualification if lead is already qualified/hot
        if (currentLead.status === 'hot' && targetStatus === 'contacted') {
          // Do not demote hot lead back to contacted via casual AI response
        } else {
          safeUpdates.status = targetStatus;
        }
      } else {
        logger.warn('Invalid AI status rejected', { attempted_status: targetStatus });
      }
    }

    // 4. Human Handoff validation
    if (proposedUpdates.needs_human !== undefined) {
      safeUpdates.needs_human = Boolean(proposedUpdates.needs_human);

      if (proposedUpdates.handoff_reason && typeof proposedUpdates.handoff_reason === 'string') {
        const reason = proposedUpdates.handoff_reason.toLowerCase().trim();
        if (ALLOWED_HANDOFF_REASONS.includes(reason)) {
          safeUpdates.handoff_reason = reason;
        } else {
          safeUpdates.handoff_reason = 'other';
        }
      } else if (safeUpdates.needs_human) {
        safeUpdates.handoff_reason = 'human_requested';
      }
    }

    // 5. Notes sanitization & length bounding (max 500 chars)
    const rawNote = proposedUpdates.summary || proposedUpdates.notes;
    if (rawNote && typeof rawNote === 'string') {
      const cleanNote = rawNote.replace(/[<>]/g, '').trim().slice(0, 500);
      if (cleanNote.length > 0) {
        const prefix = proposedUpdates.summary ? '[Staff Handoff]' : '[AI Assessment]';
        safeUpdates.notes = currentLead.notes
          ? `${currentLead.notes}\n${prefix} ${cleanNote}`
          : `${prefix} ${cleanNote}`;
      }
    }

    return safeUpdates;
  }

  /**
   * K33: health-related businesses (business profile `healthRelated`: clinics, pharmacies,
   * physiotherapy, wellness). Any message about symptoms, conditions, medicines or safety goes to
   * staff with a fixed reply and no AI. Business-agnostic wording; deliberately broad (a false alarm
   * costs one staff call, a miss could be advice). Admin questions (prices, timings, location,
   * appointments) without those words still reach the assistant.
   * @returns {{ isHealthQuestion: boolean, replyText: string|null, handoffReason: string|null }}
   */
  checkHealthQuestion(text = '') {
    const t = ` ${String(text || '').toLowerCase().normalize('NFKC')} `;
    const hit = HEALTH_STRONG.some(re => re.test(t)) || (HEALTH_TOPIC.some(re => re.test(t)) && HEALTH_PERSONAL.some(re => re.test(t)));
    if (!hit) return { isHealthQuestion: false, replyText: null, handoffReason: null };
    logger.info('Health question in a health-related business: sent to staff, no AI');
    return { isHealthQuestion: true, replyText: HEALTH_REPLIES[healthLang(text)] || HEALTH_REPLIES.en, handoffReason: 'injury_question' };
  }

  /** K33: the fixed "no medical advice" reply in the lead's language. */
  healthReply(text = '') { return HEALTH_REPLIES[healthLang(text)] || HEALTH_REPLIES.en; }

  /** K33: the short reply while a health hand-off is open (no AI), in the lead's language. */
  healthHoldReply(text = '') { return HEALTH_HOLD[healthLang(text)] || HEALTH_HOLD.en; }

  /** K33 safety net: true when the assistant's own reply reads like medical advice. */
  looksLikeAdvice(reply = '') { return ADVICE_RE.test(String(reply || '').toLowerCase()); }

  /**
   * Checks if customer message contains medical, injury, or clinical questions.
   * Prohibits AI medical diagnosis and triggers human handoff.
   * @param {string} text
   * @returns {{ isMedicalQuery: boolean, disclaimerText: string|null }}
   */
  checkMedicalInjurySafety(text = '') {
    const textLower = text.toLowerCase();
    const medicalKeywords = [
      'slipped disc', 'slip disc', 'herniated disc', 'disc herniation', 'sciatica',
      'back pain', 'spinal', 'spine',
      'torn acl', 'acl tear', 'meniscus', 'ligament tear',
      'rotator cuff', 'fracture', 'broken bone',
      'heart condition', 'cardiac', 'blood pressure', 'hypertension',
      'surgery', 'rehab', 'rehabilitation', 'physiotherapy',
      'severe pain', 'chest pain', 'doctor said'
    ];

    const hasMedicalQuery = medicalKeywords.some(keyword => textLower.includes(keyword));

    if (hasMedicalQuery) {
      logger.info('Medical/injury query detected in customer message. Escalating to staff.', {
        snippet: text.slice(0, 50)
      });

      return {
        isMedicalQuery: true,
        disclaimerText: "Thanks for telling us. We do not diagnose injuries or give medical advice on WhatsApp, so please check with your doctor first. One of our senior coaches will call you to talk about training safely around it.",
        handoffReason: 'injury_question'
      };
    }

    return {
      isMedicalQuery: false,
      disclaimerText: null,
      handoffReason: null
    };
  }
}

module.exports = new AIPolicy();
module.exports.AIPolicy = AIPolicy;
