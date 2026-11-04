const { EventEmitter } = require('events');

/**
 * In-process wake-up calls for the queue workers. Code that adds work (for
 * example the CRM queueing a staff reply) emits 'outbound' so the worker starts
 * at once instead of waiting for its next poll. Polling stays as the backup for
 * retries and crash recovery. One dyno today; with several, swap this for
 * Postgres LISTEN/NOTIFY.
 */
const signals = new EventEmitter();
signals.setMaxListeners(20);
module.exports = signals;
