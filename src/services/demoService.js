const tenantService = require('./tenantService');
const leadRepository = require('../db/leadRepository');
const outboundRepository = require('../db/outboundRepository');
const aiPolicy = require('./aiPolicy');
const deterministicRouter = require('./deterministicRouter');
const aiService = require('./aiService');
const gymConfig = require('../config/gymConfig');
const { getDatabase, runTransaction } = require('../db/database');
const logger = require('../utils/logger');

const DEMO_TENANT_ID = 'goldkraft';
const DEMO_WA_ID = process.env.DEMO_WA_ID || 'demo_919876543210';
const DEMO_DISPLAY_NAME = 'Rahul Sharma';

class DemoService {
  constructor() {
    this.demoTenantId = DEMO_TENANT_ID;
    this.demoWaId = DEMO_WA_ID;
    this.demoDisplayName = DEMO_DISPLAY_NAME;
  }

  /**
   * Resolves the dedicated demo tenant from database / tenant configuration.
   */
  getDemoTenant() {
    const tenant = tenantService.getTenantById(this.demoTenantId) ||
                   tenantService.resolveTenantByPhoneNumberId('default');

    if (!tenant) {
      return {
        id: this.demoTenantId,
        name: 'Goldkraft Fitness',
        configuration: {
          pricing_monthly: 4040,
          location: 'ITI Layout, 1st Phase, J.P. Nagar, Bengaluru, Karnataka 560078'
        }
      };
    }
    return tenant;
  }

  /**
   * Retrieves or creates the fixed demo lead record.
   */
  getOrCreateDemoLead(tenantId = this.demoTenantId) {
    let lead = leadRepository.findByWaId(this.demoWaId, tenantId);
    if (!lead) {
      lead = leadRepository.getOrCreateLead(
        this.demoWaId,
        this.demoDisplayName,
        new Date().toISOString(),
        tenantId
      );
    }
    return lead;
  }

  /**
   * Formats the demo lead object for client consumption (CRM Lead Summary).
   */
  formatDemoLead(lead) {
    if (!lead) {
      return {
        name: this.demoDisplayName,
        wa_id: this.demoWaId,
        display_phone: '+91 98765 43210',
        tenant_id: this.demoTenantId,
        tenant_name: 'Goldkraft Fitness',
        location: 'JP Nagar, Bengaluru',
        status: 'new',
        interest: 'Personal Training',
        needs_human: false,
        handoff_reason: null,
        notes: 'None'
      };
    }

    return {
      name: lead.display_name || this.demoDisplayName,
      wa_id: lead.wa_id,
      display_phone: '+91 98765 43210',
      tenant_id: lead.tenant_id || this.demoTenantId,
      tenant_name: 'Goldkraft Fitness',
      location: 'JP Nagar, Bengaluru',
      status: lead.status || 'new',
      interest: lead.interest || 'Personal Training',
      needs_human: Boolean(lead.needs_human),
      handoff_reason: lead.handoff_reason || null,
      notes: lead.notes || 'None'
    };
  }

  /**
   * Orchestrates the real backend AI pipeline for an incoming demo message.
   * Reproduces the production pipeline:
   * 1. Resolve demo tenant
   * 2. Get/create demo lead
   * 3. Persist incoming customer message
   * 4. Medical / injury safety check
   * 5. Deterministic router check
   * 6. Real AI Service (prompt assembly, OpenRouter, tool calling loop, CRM updates)
   * 7. Persist outbound reply
   * 8. Enqueue in outbound queue
   * 9. Return clean response with refreshed lead state
   */
  async processDemoChat(incomingText) {
    if (!incomingText || typeof incomingText !== 'string' || !incomingText.trim()) {
      const err = new Error('Message text is required');
      err.statusCode = 400;
      throw err;
    }

    const trimmedText = incomingText.trim();
    if (trimmedText.length > 1000) {
      const err = new Error('Message text exceeds maximum length of 1000 characters');
      err.statusCode = 400;
      throw err;
    }

    const tenant = this.getDemoTenant();
    let lead = this.getOrCreateDemoLead(tenant.id);

    const now = new Date().toISOString();
    const messageId = `demo_msg_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    // 3. Persist inbound message to database
    leadRepository.saveMessage({
      messageId,
      waId: this.demoWaId,
      direction: 'in',
      text: trimmedText,
      timestamp: now,
      rawPayload: { source: 'demo_ui' },
      tenantId: tenant.id
    });

    // Update lead's last inbound timestamp
    leadRepository.getOrCreateLead(this.demoWaId, lead.display_name || this.demoDisplayName, now, tenant.id);
    lead = leadRepository.findByWaId(this.demoWaId, tenant.id);

    let replyText = null;
    let source = 'ai';
    let extractedUpdates = null;

    // 4. Medical / Injury Safety Check
    const medicalCheck = aiPolicy.checkMedicalInjurySafety(trimmedText);
    if (medicalCheck.isMedicalQuery) {
      replyText = medicalCheck.disclaimerText;
      source = 'safety';
      extractedUpdates = {
        needs_human: true,
        handoff_reason: medicalCheck.handoffReason,
        summary: 'Lead asked injury/medical question in demo session.'
      };
      aiService.applyLeadUpdates(lead, extractedUpdates, tenant.id);
    } else {
      // 5. Deterministic Router Check
      const routeResult = deterministicRouter.routeMessage(trimmedText, tenant.configuration, lead);
      if (routeResult.matched) {
        replyText = routeResult.replyText;
        source = 'deterministic';
        if (routeResult.updates) {
          extractedUpdates = routeResult.updates;
          aiService.applyLeadUpdates(lead, routeResult.updates, tenant.id);
        }
      } else {
        // 6. Real AI Service (Prompt assembly, OpenRouter call, tools, dual extraction)
        const aiResult = await aiService.processInboundMessage(
          lead,
          trimmedText,
          tenant.configuration,
          tenant.id
        );
        replyText = aiResult.replyText;
        source = 'ai';
        extractedUpdates = aiResult.extractedUpdates;
      }
    }

    // Safety fallback if replyText is missing
    if (!replyText) {
      replyText = gymConfig.fallbackMessages.systemError;
      source = 'fallback';
    }

    // 7. Persist outbound reply to conversation history
    const replyMessageId = `demo_reply_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    leadRepository.saveMessage({
      messageId: replyMessageId,
      waId: this.demoWaId,
      direction: 'out',
      text: replyText,
      timestamp: new Date().toISOString(),
      rawPayload: { in_reply_to: messageId, source },
      tenantId: tenant.id
    });

    // 8. Enqueue to outboundRepository and mark sent
    try {
      const outboundRes = outboundRepository.enqueueOutbound({
        dedupKey: `reply:${messageId}`,
        tenantId: tenant.id,
        waId: this.demoWaId,
        text: replyText,
        metadata: { in_reply_to: messageId, demo: true, source }
      });
      if (outboundRes && outboundRes.id) {
        outboundRepository.markSent(outboundRes.id, `demo_provider_${Date.now()}`);
      }
    } catch (queueErr) {
      logger.warn('Failed to enqueue demo outbound message (non-fatal):', { error: queueErr.message });
    }

    // 9. Fetch latest lead state and return
    const updatedLead = leadRepository.findByWaId(this.demoWaId, tenant.id);

    return {
      success: true,
      reply: replyText,
      source,
      lead: this.formatDemoLead(updatedLead)
    };
  }

  /**
   * Retrieves conversation history and lead profile for the demo session.
   */
  getDemoConversation() {
    const tenant = this.getDemoTenant();
    const lead = this.getOrCreateDemoLead(tenant.id);
    const history = leadRepository.getConversationHistory(this.demoWaId, 50, tenant.id);

    const formattedMessages = history.map(m => ({
      id: m.id,
      sender: m.direction === 'in' ? 'customer' : 'ai',
      text: m.text,
      timestamp: m.timestamp
    }));

    return {
      success: true,
      messages: formattedMessages,
      lead: this.formatDemoLead(lead)
    };
  }

  /**
   * Retrieves current lead profile for the demo session.
   */
  getDemoLead() {
    const tenant = this.getDemoTenant();
    const lead = this.getOrCreateDemoLead(tenant.id);
    return {
      success: true,
      data: this.formatDemoLead(lead)
    };
  }

  /**
   * Deterministically cleans up ONLY the demo lead and demo conversation records.
   * Real customer data is never touched.
   */
  resetDemo() {
    const tenant = this.getDemoTenant();
    const db = getDatabase();

    runTransaction(() => {
      // 1. Delete outbound messages for demo lead
      db.prepare('DELETE FROM outbound_messages WHERE tenant_id = ? AND wa_id = ?').run(tenant.id, this.demoWaId);

      // 2. Delete handoffs for demo lead
      db.prepare('DELETE FROM handoffs WHERE tenant_id = ? AND wa_id = ?').run(tenant.id, this.demoWaId);

      // 3. Delete messages for demo lead
      db.prepare('DELETE FROM messages WHERE tenant_id = ? AND wa_id = ?').run(tenant.id, this.demoWaId);

      // 4. Delete demo lead
      db.prepare('DELETE FROM leads WHERE tenant_id = ? AND wa_id = ?').run(tenant.id, this.demoWaId);

      // 5. Recreate clean initial demo lead
      leadRepository.getOrCreateLead(this.demoWaId, this.demoDisplayName, new Date().toISOString(), tenant.id);
    }, db);

    const freshLead = leadRepository.findByWaId(this.demoWaId, tenant.id);

    logger.info('Demo conversation and lead state reset successfully', {
      wa_id: this.demoWaId,
      tenant_id: tenant.id
    });

    return {
      success: true,
      message: 'Demo conversation and lead state successfully reset.',
      lead: this.formatDemoLead(freshLead)
    };
  }
}

module.exports = new DemoService();
module.exports.DemoService = DemoService;
