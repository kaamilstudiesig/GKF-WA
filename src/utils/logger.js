const env = require('../config/env');

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};

class Logger {
  constructor() {
    this.level = env.logLevel.toLowerCase();
    this.levelScore = LOG_LEVELS[this.level] ?? LOG_LEVELS.info;
    this.isProduction = env.nodeEnv === 'production';
  }

  /**
   * Masks a phone number to prevent leaking customer PII in logs.
   * e.g. "919876543210" -> "91*****3210"
   */
  maskPhone(phone) {
    if (!phone) return 'Unknown';
    const clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length <= 4) return '***';
    return `${clean.substring(0, 2)}*****${clean.slice(-4)}`;
  }

  /**
   * Sanitizes metadata for logging (redacts secrets, API keys, tokens, and masks phone numbers)
   */
  sanitizeMeta(meta = {}, level = 'info') {
    if (!meta || typeof meta !== 'object') return meta;
    const sanitized = Array.isArray(meta) ? [...meta] : { ...meta };

    // Redact phone numbers if present
    if (sanitized.wa_id) sanitized.wa_id = this.maskPhone(sanitized.wa_id);
    if (sanitized.from) sanitized.from = this.maskPhone(sanitized.from);
    if (sanitized.to) sanitized.to = this.maskPhone(sanitized.to);
    if (sanitized.phone) sanitized.phone = this.maskPhone(sanitized.phone);
    if (sanitized.recipient_id) sanitized.recipient_id = this.maskPhone(sanitized.recipient_id);

    // Deep redact secrets, API keys, and auth headers
    const secretPattern = /token|secret|api_key|apikey|password|auth|bearer|credential/i;
    for (const key of Object.keys(sanitized)) {
      if (secretPattern.test(key)) {
        sanitized[key] = '[REDACTED SECRET]';
      } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeMeta(sanitized[key], level);
      }
    }

    // In production at info/warn level, redact or summarize message text to protect customer privacy
    if (this.isProduction && (level === 'info' || level === 'warn')) {
      if (sanitized.text && typeof sanitized.text === 'string') {
        sanitized.text_length = sanitized.text.length;
        sanitized.text = `[REDACTED PII - ${sanitized.text.length} chars]`;
      }
      if (sanitized.body && typeof sanitized.body === 'string') {
        sanitized.body_length = sanitized.body.length;
        sanitized.body = `[REDACTED PII - ${sanitized.body.length} chars]`;
      }
    }

    return sanitized;
  }

  log(level, message, meta = null) {
    if (LOG_LEVELS[level] < this.levelScore) {
      return;
    }

    const timestamp = new Date().toISOString();
    const cleanMeta = meta ? this.sanitizeMeta(meta, level) : null;

    if (this.isProduction) {
      // Structured JSON output for log aggregators (Datadog, CloudWatch, GCP)
      const logEntry = {
        timestamp,
        level: level.toUpperCase(),
        message,
        ...(cleanMeta ? { meta: cleanMeta } : {})
      };
      if (level === 'error') {
        process.stderr.write(JSON.stringify(logEntry) + '\n');
      } else {
        process.stdout.write(JSON.stringify(logEntry) + '\n');
      }
    } else {
      // Human-readable colorized terminal output for local development & testing
      const colors = {
        debug: '\x1b[36m', // Cyan
        info: '\x1b[32m',  // Green
        warn: '\x1b[33m',  // Yellow
        error: '\x1b[31m'  // Red
      };
      const reset = '\x1b[0m';
      const color = colors[level] || reset;
      const metaStr = cleanMeta ? ` ${JSON.stringify(cleanMeta)}` : '';
      const formatted = `${color}[${level.toUpperCase()}]${reset} ${message}${metaStr}`;

      if (level === 'error') {
        console.error(formatted);
      } else if (level === 'warn') {
        console.warn(formatted);
      } else {
        console.log(formatted);
      }
    }
  }

  debug(message, meta = null) {
    this.log('debug', message, meta);
  }

  info(message, meta = null) {
    this.log('info', message, meta);
  }

  warn(message, meta = null) {
    this.log('warn', message, meta);
  }

  error(message, meta = null) {
    this.log('error', message, meta);
  }
}

module.exports = new Logger();
module.exports.Logger = Logger;
