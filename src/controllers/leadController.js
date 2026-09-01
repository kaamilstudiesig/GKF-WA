const leadRepository = require('../db/leadRepository');

class LeadController {
  /**
   * GET /leads
   * List all leads with filtering, sorting, and pagination
   */
  listLeads(req, res) {
    try {
      const { status, needs_human, sort, limit, offset } = req.query;

      let needsHumanBool = undefined;
      if (needs_human === 'true' || needs_human === '1') {
        needsHumanBool = true;
      } else if (needs_human === 'false' || needs_human === '0') {
        needsHumanBool = false;
      }

      const parsedLimit = Math.min(Math.max(parseInt(limit || '50', 10), 1), 100);
      const parsedOffset = Math.max(parseInt(offset || '0', 10), 0);

      const result = leadRepository.listLeads({
        status: status || undefined,
        needsHuman: needsHumanBool,
        sortBy: sort || 'recency',
        limit: parsedLimit,
        offset: parsedOffset
      });

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
      console.error('[Lead Controller Error] Failed to list leads:', error);
      return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  }

  /**
   * GET /leads/:wa_id
   * Get complete details and conversation history for a specific lead
   */
  getLeadByWaId(req, res) {
    try {
      const waId = (req.params.wa_id || '').replace(/[^0-9]/g, '');

      if (!waId) {
        return res.status(400).json({ success: false, error: 'Invalid WhatsApp ID provided.' });
      }

      const lead = leadRepository.findByWaId(waId);

      if (!lead) {
        return res.status(404).json({ success: false, error: `Lead with WhatsApp ID +${waId} not found.` });
      }

      const conversationHistory = leadRepository.getConversationHistory(waId, 50);

      return res.status(200).json({
        success: true,
        data: {
          ...lead,
          conversation_history: conversationHistory
        }
      });
    } catch (error) {
      console.error('[Lead Controller Error] Failed to fetch lead:', error);
      return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  }
}

module.exports = new LeadController();
module.exports.LeadController = LeadController;
