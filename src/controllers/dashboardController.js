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
          SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) as qualified_leads,
          SUM(CASE WHEN status = 'hot' THEN 1 ELSE 0 END) as hot_leads,
          SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as converted_leads,
          SUM(CASE WHEN needs_human = 1 THEN 1 ELSE 0 END) as handoff_leads
        FROM leads
        WHERE tenant_id = ?
      `);
      const leadStats = leadStatsStmt.get(tenantId) || {};

      // AI token spend & requests
      const aiUsageStmt = db.prepare(`
        SELECT
          COUNT(*) as total_requests,
          COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) as total_tokens,
          COALESCE(SUM(estimated_cost_inr), 0) as total_cost_inr
        FROM ai_usage
        WHERE tenant_id = ?
      `);
      const aiStats = aiUsageStmt.get(tenantId) || {};

      // Queue status
      const eventQueueStmt = db.prepare(`
        SELECT COUNT(*) as pending_events
        FROM webhook_events
        WHERE tenant_id = ? AND status = 'pending'
      `);
      const pendingEvents = eventQueueStmt.get(tenantId)?.pending_events || 0;

      const outboundQueueStmt = db.prepare(`
        SELECT COUNT(*) as pending_outbound
        FROM outbound_messages
        WHERE tenant_id = ? AND status = 'pending'
      `);
      const pendingOutbound = outboundQueueStmt.get(tenantId)?.pending_outbound || 0;

      return res.status(200).json({
        success: true,
        data: {
          tenant_id: tenantId,
          leads: {
            total: leadStats.total_leads || 0,
            new: leadStats.new_leads || 0,
            qualified: leadStats.qualified_leads || 0,
            hot: leadStats.hot_leads || 0,
            converted: leadStats.converted_leads || 0,
            needs_human: leadStats.handoff_leads || 0
          },
          ai_usage: {
            total_requests: aiStats.total_requests || 0,
            total_tokens: aiStats.total_tokens || 0,
            estimated_cost_inr: parseFloat((aiStats.total_cost_inr || 0).toFixed(2))
          },
          queue: {
            pending_events: pendingEvents,
            pending_outbound: pendingOutbound
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
