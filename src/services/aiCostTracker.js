const db = require('../db');
const env = require('../config/env');
const logger = require('../utils/logger');

/**
 * Records every model call and enforces the monthly budget.
 * Cost comes straight from OpenRouter (usage.cost, in USD) so it is exact for
 * any model; nothing to keep in sync when the model changes.
 */
const aiCostTracker = {
  async record({ requestId, model, inputTokens = null, outputTokens = null, costUsd = null, latencyMs = null, success = true, errorType = null }) {
    try {
      await db.query(`INSERT INTO ai_usage (request_id, model, input_tokens, output_tokens, cost_usd, latency_ms, success, error_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [requestId || `req_${Date.now()}`, model || 'unknown', inputTokens, outputTokens, costUsd, latencyMs, Boolean(success), errorType]);
    } catch (err) {
      logger.error('Failed to record AI usage', { error: err.message });
    }
  },

  async monthToDate() {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    return db.one(`SELECT
        (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::int AS tokens,
        COUNT(*)::int AS requests,
        COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd
      FROM ai_usage WHERE created_at >= $1`, [start]);
  },

  /** Soft monthly guardrail; a few in-flight calls can finish after it trips. */
  async checkBudget({ tokenBudget = env.aiMonthlyTokenBudget, requestBudget = env.aiMonthlyRequestBudget } = {}) {
    const { tokens, requests } = await this.monthToDate();
    if (tokens >= tokenBudget) {
      logger.warn('Monthly AI token budget reached', { tokens, tokenBudget });
      return { exceeded: true, reason: 'token_budget_exceeded', tokens, requests };
    }
    if (requests >= requestBudget) {
      logger.warn('Monthly AI request budget reached', { requests, requestBudget });
      return { exceeded: true, reason: 'request_budget_exceeded', tokens, requests };
    }
    return { exceeded: false, tokens, requests };
  }
};

module.exports = aiCostTracker;
