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
   * Checks if customer message contains medical, injury, or clinical questions.
   * Prohibits AI medical diagnosis and triggers human handoff.
   * @param {string} text
   * @returns {{ isMedicalQuery: boolean, disclaimerText: string|null }}
   */
  checkMedicalInjurySafety(text = '') {
    const textLower = text.toLowerCase();
    const medicalKeywords = [
      'slipped disc', 'slip disc', 'herniated disc', 'sciatica',
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
        disclaimerText: "Because your health and safety are our top priority, we do not diagnose injuries or provide medical advice over WhatsApp. We recommend consulting your physician, and our senior coaching team will contact you directly to discuss how we can safely tailor training around your recovery.",
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
