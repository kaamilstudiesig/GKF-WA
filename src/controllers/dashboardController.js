const { getDatabase } = require('../db/database');
const logger = require('../utils/logger');

class DashboardController {
  /**
   * GET /dashboard/summary
   * Returns aggregated CRM metrics, AI usage, and queue status scoped to tenant.
   */
  getSummary(req, res) {
    try {
      const tenantId = req.tenantId || 'goldkraft';
      const db = getDatabase();

      // Lead breakdown by status
      const leadStatsStmt = db.prepare(`
        SELECT
          COUNT(*) as total_leads,
          SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_leads,
          SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted_leads,
          SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) as qualified_leads,
          SUM(CASE WHEN status = 'hot' THEN 1 ELSE 0 END) as hot_leads,
          SUM(CASE WHEN status = 'cold' THEN 1 ELSE 0 END) as cold_leads,
          SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted_leads,
          SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) as lost_leads,
          SUM(CASE WHEN needs_human = 1 THEN 1 ELSE 0 END) as handoff_leads
        FROM leads
        WHERE tenant_id = ?
      `);
      const leadStats = leadStatsStmt.get(tenantId) || {};

      // Handoff breakdown
      const handoffStatsStmt = db.prepare(`
        SELECT
          COUNT(*) as total_handoffs,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_handoffs,
          SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as assigned_handoffs,
          SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_handoffs
        FROM handoffs
        WHERE tenant_id = ?
      `);
      const handoffStats = handoffStatsStmt.get(tenantId) || {};

      // AI token spend, requests, latency, fallbacks
      const aiUsageStmt = db.prepare(`
        SELECT
          COUNT(*) as total_requests,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_requests,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests,
          SUM(CASE WHEN request_id LIKE '%_fallback' THEN 1 ELSE 0 END) as fallback_requests,
          COALESCE(SUM(input_tokens), 0) as total_input_tokens,
          COALESCE(SUM(output_tokens), 0) as total_output_tokens,
          COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) as total_tokens,
          COALESCE(SUM(estimated_cost_inr), 0) as total_cost_inr,
          COALESCE(AVG(latency_ms), 0) as avg_latency_ms
        FROM ai_usage
        WHERE tenant_id = ?
      `);
      const aiStats = aiUsageStmt.get(tenantId) || {};

      // Queue status (Inbound Webhook Events & Outbound Messages)
      const eventQueueStmt = db.prepare(`
        SELECT
          COUNT(*) as total_events,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_events,
          SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) as processing_events,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed_events,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_events,
          SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) as dead_letter_events
        FROM webhook_events
        WHERE tenant_id = ?
      `);
      const eventStats = eventQueueStmt.get(tenantId) || {};

      const outboundQueueStmt = db.prepare(`
        SELECT
          COUNT(*) as total_outbound,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_outbound,
          SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) as sending_outbound,
          SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) as sent_outbound,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_outbound,
          SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) as dead_letter_outbound
        FROM outbound_messages
        WHERE tenant_id = ?
      `);
      const outboundStats = outboundQueueStmt.get(tenantId) || {};

      return res.status(200).json({
        success: true,
        data: {
          tenant_id: tenantId,
          leads: {
            total: leadStats.total_leads || 0,
            new: leadStats.new_leads || 0,
            contacted: leadStats.contacted_leads || 0,
            qualified: leadStats.qualified_leads || 0,
            hot: leadStats.hot_leads || 0,
            cold: leadStats.cold_leads || 0,
            converted: leadStats.converted_leads || 0,
            lost: leadStats.lost_leads || 0,
            needs_human: leadStats.handoff_leads || 0
          },
          handoffs: {
            total: handoffStats.total_handoffs || 0,
            pending: handoffStats.pending_handoffs || 0,
            assigned: handoffStats.assigned_handoffs || 0,
            resolved: handoffStats.resolved_handoffs || 0
          },
          ai_usage: {
            total_requests: aiStats.total_requests || 0,
            successful_requests: aiStats.successful_requests || 0,
            failed_requests: aiStats.failed_requests || 0,
            fallback_requests: aiStats.fallback_requests || 0,
            input_tokens: aiStats.total_input_tokens || 0,
            output_tokens: aiStats.total_output_tokens || 0,
            total_tokens: aiStats.total_tokens || 0,
            estimated_cost_inr: parseFloat((aiStats.total_cost_inr || 0).toFixed(2)),
            avg_latency_ms: Math.round(aiStats.avg_latency_ms || 0)
          },
          queue: {
            inbound_events: {
              total: eventStats.total_events || 0,
              pending: eventStats.pending_events || 0,
              processing: eventStats.processing_events || 0,
              completed: eventStats.completed_events || 0,
              failed: eventStats.failed_events || 0,
              dead_letter: eventStats.dead_letter_events || 0
            },
            outbound_messages: {
              total: outboundStats.total_outbound || 0,
              pending: outboundStats.pending_outbound || 0,
              sending: outboundStats.sending_outbound || 0,
              sent: outboundStats.sent_outbound || 0,
              failed: outboundStats.failed_outbound || 0,
              dead_letter: outboundStats.dead_letter_outbound || 0
            },
            pending_events: eventStats.pending_events || 0,
            pending_outbound: outboundStats.pending_outbound || 0
          }
        }
      });
    } catch (err) {
      logger.error('Failed to generate dashboard summary:', { error: err.message });
      return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
  }
}

module.exports = new DashboardController();
module.exports.DashboardController = DashboardController;
