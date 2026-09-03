const leadRepository = require('../db/leadRepository');
const handoffRepository = require('../db/handoffRepository');
const auditService = require('../services/auditService');
const { runTransaction } = require('../db/database');
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

  /**
   * PATCH /leads/:wa_id
   * Allows authorized human staff to update lead properties (including converting leads)
   * Records an audit log entry for compliance and tracking.
   */
  updateLead(req, res) {
    try {
      const rawWaId = req.params.wa_id || '';
      const cleanWaId = rawWaId.replace(/[^0-9]/g, '');

      if (!cleanWaId || cleanWaId.length < 7 || cleanWaId.length > 15) {
        return res.status(400).json({
          success: false,
          error: 'Invalid WhatsApp ID format. Must contain 7 to 15 digits without symbols.'
        });
      }

      const tenantId = req.tenantId || 'goldkraft';
      const existingLead = leadRepository.findByWaId(cleanWaId, tenantId);

      if (!existingLead) {
        return res.status(404).json({
          success: false,
          error: `Lead with WhatsApp ID +${cleanWaId} not found.`
        });
      }

      const updates = req.body || {};
      const safeUpdates = {};

      if (updates.status !== undefined) {
        if (!ALLOWED_STATUSES.includes(updates.status)) {
          return res.status(400).json({
            success: false,
            error: `Invalid status parameter. Allowed values: ${ALLOWED_STATUSES.join(', ')}`
          });
        }
        safeUpdates.status = updates.status;
      }

      if (updates.interest !== undefined) safeUpdates.interest = String(updates.interest).trim();
      if (updates.display_name !== undefined) safeUpdates.display_name = String(updates.display_name).trim();

      if (updates.notes !== undefined) {
        safeUpdates.notes = updates.notes;
      }

      let updatedLead;
      runTransaction(() => {
        if (updates.needs_human !== undefined) {
          safeUpdates.needs_human = Boolean(updates.needs_human);
          if (updates.needs_human && updates.handoff_reason) {
            safeUpdates.handoff_reason = updates.handoff_reason;
            handoffRepository.recordHandoff({
              tenantId,
              waId: cleanWaId,
              reason: updates.handoff_reason,
              summary: updates.summary || 'Staff manual handoff trigger'
            });
          } else if (!updates.needs_human) {
            safeUpdates.handoff_reason = null;
            handoffRepository.resolveHandoff(tenantId, cleanWaId);
          }
        }

        updatedLead = leadRepository.updateLead(cleanWaId, safeUpdates, tenantId);

        // Record audit log for staff mutation atomically
        auditService.recordAudit({
          tenantId,
          actorId: req.user?.id || 'staff',
          actorRole: req.userRole || 'staff',
          action: 'lead_update',
          targetType: 'lead',
          targetId: cleanWaId,
          changes: {
            before: { status: existingLead.status, needs_human: existingLead.needs_human, notes: existingLead.notes },
            after: safeUpdates
          },
          ipAddress: req.ip
        });
      });

      return res.status(200).json({
        success: true,
        data: updatedLead
      });
    } catch (error) {
      logger.error('Failed to update lead:', { error: error.message, stack: error.stack });
      return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  }
}

module.exports = new LeadController();
module.exports.LeadController = LeadController;
