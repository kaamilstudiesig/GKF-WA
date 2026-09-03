const { getDatabase } = require('../db/database');
const logger = require('../utils/logger');

class AICostTracker {
  constructor(db = null) {
    this.customDb = db;
  }

  get db() {
    return this.customDb || getDatabase();
  }

  /**
   * Records an AI usage event into the database.
   * Does not fabricate tokens if provider does not supply them.
   */
  recordUsage({
    tenantId = 'goldkraft',
    requestId,
    model,
    inputTokens = null,
    outputTokens = null,
    cachedTokens = null,
    latencyMs = null,
    success = true,
    errorType = null
  }) {
    const now = new Date().toISOString();
    let estimatedCostInr = null;

    // Approximate cost in INR for Gemini 2.5 Flash (~$0.10/M in, $0.40/M out @ ~₹85/$)
    if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
      const inputCostUsd = (inputTokens / 1000000) * 0.10;
      const outputCostUsd = (outputTokens / 1000000) * 0.40;
      estimatedCostInr = parseFloat(((inputCostUsd + outputCostUsd) * 85).toFixed(4));
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO ai_usage (
          tenant_id, request_id, model, input_tokens, output_tokens,
          cached_tokens, estimated_cost_inr, latency_ms, success, error_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        tenantId,
        requestId || `req_${Date.now()}`,
        model || 'unknown',
        inputTokens,
        outputTokens,
        cachedTokens,
        estimatedCostInr,
        latencyMs,
        success ? 1 : 0,
        errorType,
        now
      );
    } catch (err) {
      logger.error('Failed to record AI usage:', { error: err.message });
    }
  }

  /**
   * Checks if tenant has exceeded their monthly token or request budget guardrails.
   * @param {string} tenantId
   * @param {object} tenantConfig
   * @returns {{ exceeded: boolean, reason?: string, currentTokens: number, currentRequests: number }}
   */
  checkBudget(tenantId = 'goldkraft', tenantConfig = {}) {
    const monthlyTokenBudget = tenantConfig.monthly_token_budget || 500000;
    const monthlyRequestBudget = tenantConfig.monthly_request_budget || 5000;

    // First day of current month in UTC
    const date = new Date();
    const startOfMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString();

    const stmt = this.db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) as total_tokens,
        COUNT(*) as total_requests
      FROM ai_usage
      WHERE tenant_id = ? AND created_at >= ?
    `);

    const result = stmt.get(tenantId, startOfMonth) || { total_tokens: 0, total_requests: 0 };
    const currentTokens = result.total_tokens || 0;
    const currentRequests = result.total_requests || 0;

    if (currentTokens >= monthlyTokenBudget) {
      logger.warn('Tenant AI monthly token budget exceeded', { tenantId, currentTokens, monthlyTokenBudget });
      return { exceeded: true, reason: 'token_budget_exceeded', currentTokens, currentRequests };
    }

    if (currentRequests >= monthlyRequestBudget) {
      logger.warn('Tenant AI monthly request budget exceeded', { tenantId, currentRequests, monthlyRequestBudget });
      return { exceeded: true, reason: 'request_budget_exceeded', currentTokens, currentRequests };
    }

    return { exceeded: false, currentTokens, currentRequests };
  }
}

module.exports = new AICostTracker();
module.exports.AICostTracker = AICostTracker;
