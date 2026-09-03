const outboundRepository = require('../db/outboundRepository');
const whatsappService = require('../services/whatsappService');
const logger = require('../utils/logger');

class OutboundWorker {
  constructor() {
    this.timer = null;
    this.isRunning = false;
    this.isProcessing = false;
  }

  /**
   * Classifies whether an HTTP / network error from Meta Cloud API is retryable.
   */
  isRetryableError(error) {
    if (!error.response) {
      // Network timeout, connection reset, DNS lookup error
      return true;
    }
    const status = error.response.status;
    if (status === 429) return true; // Rate limited by Meta
    if (status >= 500 && status <= 599) return true; // Meta server error
    return false; // 400, 401, 403, 404: Permanent configuration or client errors
  }

  /**
   * Processes a single pending outbound message.
   * @returns {Promise<boolean>} True if a message was processed, false if queue was empty
   */
  async processNext() {
    const message = outboundRepository.getNextPendingMessage(60);
    if (!message) return false;

    logger.debug('Processing outbound message job', {
      id: message.id,
      wa_id: message.wa_id,
      attempts: message.attempts
    });

    try {
      const result = await whatsappService.sendTextMessage(message.wa_id, message.text, {
        tenantId: message.tenant_id,
        skipQueue: true // prevents re-enqueueing if whatsappService is called
      });

      const providerMsgId = result?.messages?.[0]?.id || null;
      outboundRepository.markSent(message.id, providerMsgId);

      logger.info('Outbound message sent successfully', {
        id: message.id,
        provider_message_id: providerMsgId,
        wa_id: message.wa_id
      });
      return true;
    } catch (error) {
      const retryable = this.isRetryableError(error);
      const errMsg = error.response?.data ? JSON.stringify(error.response.data) : error.message;

      logger.error('Outbound message send failed', {
        id: message.id,
        wa_id: message.wa_id,
        retryable,
        error: errMsg
      });

      outboundRepository.markFailed(message.id, errMsg, retryable);
      return true;
    }
  }

  /**
   * Drains all currently available pending outbound messages (useful for tests and shutdown)
   */
  async drain(maxCycles = 50) {
    let count = 0;
    while (count < maxCycles) {
      const processed = await this.processNext();
      if (!processed) break;
      count++;
    }
    return count;
  }

  /**
   * Starts worker background polling loop
   */
  start(intervalMs = 1000) {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(async () => {
      if (this.isProcessing || !this.isRunning) return;
      this.isProcessing = true;
      try {
        await this.processNext();
      } catch (err) {
        logger.error('Outbound worker polling loop error:', { error: err.message });
      } finally {
        this.isProcessing = false;
      }
    }, intervalMs);

    logger.info('Outbound WhatsApp worker started', { intervalMs });
  }

  /**
   * Gracefully stops the worker
   */
  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait briefly if actively processing
    let waits = 0;
    while (this.isProcessing && waits < 10) {
      await new Promise(res => setTimeout(res, 100));
      waits++;
    }
    logger.info('Outbound WhatsApp worker stopped.');
  }
}

module.exports = new OutboundWorker();
module.exports.OutboundWorker = OutboundWorker;
