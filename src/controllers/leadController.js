const leadRepository = require('../db/leadRepository');
const logger = require('../utils/logger');

const ALLOWED_STATUSES = ['new', 'contacted', 'qualified', 'hot', 'cold', 'converted', 'lost'];
const ALLOWED_SORTS = ['recency', 'oldest', 'created_recent', 'needs_human_first'];

class LeadController {
  /**
   * GET /leads
   * List all leads with validated filtering, sorting, and pagination
   */
  listLeads(req, res) {
    try {
      const { status, needs_human, sort, limit, offset } = req.query;

      // Validate status query param if provided
      if (status && !ALLOWED_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Invalid status parameter. Allowed values: ${ALLOWED_STATUSES.join(', ')}`
        });
      }

      // Validate sort query param if provided
      if (sort && !ALLOWED_SORTS.includes(sort)) {
        return res.status(400).json({
          success: false,
          error: `Invalid sort parameter. Allowed values: ${ALLOWED_SORTS.join(', ')}`
        });
      }

      // Validate needs_human query param if provided
      let needsHumanBool = undefined;
      if (needs_human !== undefined) {
        if (needs_human === 'true' || needs_human === '1') {
          needsHumanBool = true;
        } else if (needs_human === 'false' || needs_human === '0') {
          needsHumanBool = false;
        } else {
          return res.status(400).json({
            success: false,
            error: "Invalid needs_human parameter. Must be 'true' or 'false'."
          });
        }
      }

      // Validate and sanitize pagination
      const parsedLimit = Math.min(Math.max(parseInt(limit || '50', 10) || 50, 1), 100);
      const parsedOffset = Math.max(parseInt(offset || '0', 10) || 0, 0);

      const result = leadRepository.listLeads({
        tenantId: req.tenantId || 'goldkraft',
        status: status || undefined,
        needsHuman: needsHumanBool,
        sortBy: sort || 'recency',
        limit: parsedLimit,
        offset: parsedOffset
      });

      logger.debug('Retrieved leads list', { count: result.leads.length, total: result.total, tenant_id: req.tenantId });

      return res.status(200).json({
        success: true,
        data: result.leads,
        pagination: {
          total: result.total,
          limit: result.limit,
          offset: result.offset
        }
      });
    } catch (error) {
      logger.error('Failed to list leads:', { error: error.message, stack: error.stack });
      return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  }

  /**
   * GET /leads/:wa_id
   * Get complete details and conversation history for a specific lead scoped to tenant
   */
  getLeadByWaId(req, res) {
    try {
      const rawWaId = req.params.wa_id || '';
      const cleanWaId = rawWaId.replace(/[^0-9]/g, '');

      // Strict E.164 phone number validation (7 to 15 digits)
      if (!cleanWaId || cleanWaId.length < 7 || cleanWaId.length > 15) {
        return res.status(400).json({
          success: false,
          error: 'Invalid WhatsApp ID format. Must contain 7 to 15 digits without symbols.'
        });
      }

      const tenantId = req.tenantId || 'goldkraft';
      const lead = leadRepository.findByWaId(cleanWaId, tenantId);

      if (!lead) {
        return res.status(404).json({
          success: false,
          error: `Lead with WhatsApp ID +${cleanWaId} not found.`
        });
      }

      const conversationHistory = leadRepository.getConversationHistory(cleanWaId, 50, tenantId);

      logger.debug('Retrieved lead profile', { wa_id: cleanWaId, tenant_id: tenantId, messages: conversationHistory.length });

      return res.status(200).json({
        success: true,
        data: {
          ...lead,
          conversation_history: conversationHistory
        }
      });
    } catch (error) {
      logger.error('Failed to fetch lead:', { error: error.message, stack: error.stack });
      return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  }
}

module.exports = new LeadController();
module.exports.LeadController = LeadController;
