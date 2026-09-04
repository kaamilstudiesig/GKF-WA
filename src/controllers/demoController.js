const demoService = require('../services/demoService');
const logger = require('../utils/logger');

class DemoController {
  /**
   * POST /demo/chat
   * Processes a demo customer message through the real backend AI pipeline.
   * Client-supplied tenantId is ignored to guarantee tenant isolation.
   */
  async chat(req, res) {
    try {
      const message = req.body?.message;

      if (!message || typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Missing required "message" field in request body.'
        });
      }

      const result = await demoService.processDemoChat(message);
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Failed to process demo chat message:', {
        error: error.message,
        stack: error.stack
      });

      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({
        success: false,
        error: statusCode === 400 ? error.message : 'An error occurred while processing your message.'
      });
    }
  }

  /**
   * GET /demo/conversation
   * Retrieves conversation history for the demo session.
   */
  getConversation(req, res) {
    try {
      const result = demoService.getDemoConversation();
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Failed to fetch demo conversation:', { error: error.message });
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve demo conversation.'
      });
    }
  }

  /**
   * GET /demo/lead
   * Retrieves current lead profile for the demo session.
   */
  getLead(req, res) {
    try {
      const result = demoService.getDemoLead();
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Failed to fetch demo lead profile:', { error: error.message });
      return res.status(500).json({
        success: false,
        error: 'Failed to retrieve demo lead profile.'
      });
    }
  }

  /**
   * POST /demo/reset
   * Resets the demo conversation and demo lead state deterministically.
   */
  reset(req, res) {
    try {
      const result = demoService.resetDemo();
      return res.status(200).json(result);
    } catch (error) {
      logger.error('Failed to reset demo state:', { error: error.message });
      return res.status(500).json({
        success: false,
        error: 'Failed to reset demo session.'
      });
    }
  }
}

module.exports = new DemoController();
module.exports.DemoController = DemoController;
