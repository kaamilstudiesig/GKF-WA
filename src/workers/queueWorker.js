const logger = require('../utils/logger');

/**
 * Small polling worker for a Postgres-backed queue.
 * - claim(): atomically takes the next job (or null when the queue is empty)
 * - handle(job): does the work and marks the job done/failed itself
 * Runs up to `concurrency` jobs at once, polls every `intervalMs`, and can be
 * woken immediately with kick() when new work arrives.
 */
class QueueWorker {
  constructor(name, { claim, handle, concurrency = 1, intervalMs = 2000 }) {
    this.name = name;
    this.claim = claim;
    this.handle = handle;
    this.concurrency = concurrency;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.active = 0;
    this.running = false;
  }

  /** Processes jobs until the queue is empty. Returns how many were handled. */
  async drain(max = Infinity) {
    let handled = 0;
    while (handled < max) {
      const job = await this.claim();
      if (!job) break;
      try {
        await this.handle(job);
      } catch (err) {
        logger.error(`${this.name} job crashed`, { id: job.id, error: err.message });
      }
      handled++;
    }
    return handled;
  }

  /** Fills free worker slots; each slot drains until the queue is empty. */
  kick() {
    while (this.active < this.concurrency) {
      this.active++;
      this.drain()
        .catch(err => logger.error(`${this.name} poll failed`, { error: err.message }))
        .finally(() => { this.active--; });
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
    this.kick();
    logger.info(`${this.name} started`, { concurrency: this.concurrency, intervalMs: this.intervalMs });
  }

  async stop(timeoutMs = 8000) {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + timeoutMs;
    while (this.active > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  }
}

module.exports = QueueWorker;
