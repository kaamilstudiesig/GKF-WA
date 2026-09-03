const gymConfig = require('../config/gymConfig');
const logger = require('../utils/logger');

class DeterministicRouter {
  /**
   * Evaluates if an inbound message matches a deterministic high-confidence intent
   * to bypass LLM inference and reduce token costs.
   * @param {string} text - Inbound message body
   * @param {object} tenantConfig - Business configuration
   * @param {object} lead - Current lead state
   * @returns {{ matched: boolean, replyText?: string, updates?: object }}
   */
  routeMessage(text = '', tenantConfig = {}, lead = {}) {
    const cleanText = text.toLowerCase().trim();

    // 1. Operating Hours & Schedule
    const hoursKeywords = [
      'what time do you open', 'opening hours', 'gym timing', 'gym timings',
      'working hours', 'operating hours', 'close time', 'closing time',
      'sunday timing', 'timings'
    ];
    if (hoursKeywords.some(kw => cleanText === kw || cleanText.includes(kw))) {
      logger.debug('Deterministic route matched: Operating Hours', { wa_id: lead.wa_id });
      const weekday = tenantConfig.hours?.weekday || gymConfig.hours.weekday;
      const sunday = tenantConfig.hours?.sunday || gymConfig.hours.sunday;
      return {
        matched: true,
        replyText: `Goldkraft Fitness operating hours:\n• ${weekday}\n• ${sunday}\n\nWhen would you like to drop by for a workout or facility tour?`,
        updates: { status: 'contacted' }
      };
    }

    // 2. Physical Location & Parking
    const locationKeywords = [
      'where are you located', 'where is the gym', 'gym address', 'your location',
      'location please', 'send location', 'where is it located', 'parking available'
    ];
    if (locationKeywords.some(kw => cleanText === kw || cleanText.includes(kw))) {
      logger.debug('Deterministic route matched: Location', { wa_id: lead.wa_id });
      const loc = tenantConfig.facility?.location || gymConfig.facility.location;
      const parking = tenantConfig.facility?.parking || gymConfig.facility.parking;
      return {
        matched: true,
        replyText: `We are located at: ${loc}.\n\nParking: ${parking}.\n\nAre you looking to visit for a personal consultation or trial session?`,
        updates: { status: 'contacted' }
      };
    }

    // 3. Explicit Human / Staff Request
    const humanKeywords = [
      'talk to human', 'speak to a person', 'speak to someone', 'call me',
      'customer support', 'human agent', 'human staff', 'connect to coach',
      'speak to manager', 'connect me to', 'real person', 'speak to staff'
    ];
    if (humanKeywords.some(kw => cleanText === kw || cleanText.includes(kw))) {
      logger.debug('Deterministic route matched: Human Request', { wa_id: lead.wa_id });
      return {
        matched: true,
        replyText: "Understood! I've notified our coaching team at Goldkraft Fitness. A senior staff member will reach out to you shortly.",
        updates: {
          needs_human: true,
          handoff_reason: 'human_requested',
          summary: 'Lead requested direct conversation with human staff.'
        }
      };
    }

    // 4. Complaints & Grievances
    const complaintKeywords = ['complaint', 'dirty', 'broken', 'not working', 'unacceptable', 'rude', 'hygiene'];
    if (complaintKeywords.some(kw => cleanText.includes(kw))) {
      logger.debug('Deterministic route matched: Complaint', { wa_id: lead.wa_id });
      return {
        matched: true,
        replyText: "We sincerely apologize for this experience. We take facility standards very seriously at Goldkraft Fitness. Our management has been notified and will contact you directly.",
        updates: {
          needs_human: true,
          handoff_reason: 'complaint',
          summary: 'Customer reported facility or service complaint.'
        }
      };
    }

    // 4. Trial Session Booking Request
    const trialKeywords = [
      'book a trial', 'book trial', 'trial session', 'free trial', 'try a workout',
      'first workout free', 'book free trial'
    ];
    if (trialKeywords.some(kw => cleanText === kw || cleanText.includes(kw))) {
      logger.debug('Deterministic route matched: Trial Booking', { wa_id: lead.wa_id });
      return {
        matched: true,
        replyText: "You can book an introductory trial session with us! We have certified coaches on deck from 5 AM to 10 PM. Which day and time works best for your trial visit?",
        updates: {
          interest: 'trial_booking',
          status: 'hot',
          needs_human: true,
          handoff_reason: 'ready_to_book',
          summary: 'Lead explicitly requested trial booking.'
        }
      };
    }

    return { matched: false };
  }
}

module.exports = new DeterministicRouter();
module.exports.DeterministicRouter = DeterministicRouter;
