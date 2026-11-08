/**
 * R3: live board. Postgres triggers (platform migration 4) NOTIFY 'crm_board' with the
 * client's tenant id whenever a card could move. Every CRM server LISTENs, so this works
 * with more than one web dyno. Each open board holds a server-sent events stream
 * (GET /events) and gets a bare "board changed" ping for its own client only; the page
 * then reloads the board through the normal, role-scoped page. The stream never carries
 * lead details, so a sales person learns nothing about leads they can't see.
 */

const CHANNEL = 'crm_board';
const DEBOUNCE_MS = 400; // a burst of changes (one outcome touches several tables) -> one ping
// Every inbound WhatsApp message changes a lead, and each ping makes every open board
// reload the pipeline. So at most one ping per client every 5 s; a change inside that
// window still gets a (trailing) ping at the end of it, so the final state always arrives.
const MIN_INTERVAL_MS = 5000;
const HEARTBEAT_MS = 25000; // under Heroku's 55 s idle timeout

class LiveBoard {
  /** db needs listen(channel, fn) (src/db). Without it the board just isn't live. */
  constructor(db, { debounceMs = DEBOUNCE_MS, minIntervalMs = MIN_INTERVAL_MS, heartbeatMs = HEARTBEAT_MS } = {}) {
    this.db = db;
    this.debounceMs = debounceMs;
    this.minIntervalMs = minIntervalMs;
    this.lastPing = new Map(); // tenantId -> time of the last ping sent
    this.heartbeatMs = heartbeatMs;
    this.clients = new Map(); // tenantId -> Set(res)
    this.timers = new Map(); // tenantId -> pending ping
    this.listening = null;
    this.heartbeat = null;
  }

  get enabled() { return typeof this.db.listen === 'function'; }

  start() {
    if (!this.listening && this.enabled) {
      // Each time LISTEN starts (first connect or after a drop), changes before it were never announced: refresh every board.
      const onReconnect = () => { for (const tenantId of this.clients.keys()) this.ping(tenantId); };
      this.listening = this.db.listen(CHANNEL, payload => this.notified(payload), { onReconnect }).catch(err => {
        this.listening = null; // try again with the next viewer
        console.error('Live board: LISTEN failed', err.message);
      });
    }
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.each(res => res.write(': ping\n\n')), this.heartbeatMs);
      this.heartbeat.unref();
    }
    return this.listening;
  }

  async stop() {
    clearInterval(this.heartbeat); this.heartbeat = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.each(res => res.end());
    this.clients.clear();
    const unlisten = this.listening && await this.listening;
    this.listening = null;
    if (typeof unlisten === 'function') await unlisten();
  }

  each(fn) { for (const set of this.clients.values()) for (const res of set) fn(res); }

  /**
   * A NOTIFY from Postgres: ping that tenant's boards. Changes are gathered for
   * debounceMs, and pings to one tenant are at least minIntervalMs apart; a change
   * while a ping is pending is folded into it (trailing), so nothing is lost.
   */
  notified(payload) {
    let tenantId;
    try { tenantId = Number(JSON.parse(payload).t); } catch (e) { return; }
    this.ping(tenantId);
  }

  /** Pings one tenant's open boards, debounced and rate-limited as described above. */
  ping(tenantId) {
    if (!this.clients.has(tenantId) || this.timers.has(tenantId)) return;
    const sinceLast = Date.now() - (this.lastPing.get(tenantId) || 0);
    const wait = Math.max(this.debounceMs, this.minIntervalMs - sinceLast);
    this.timers.set(tenantId, setTimeout(() => {
      this.timers.delete(tenantId);
      this.lastPing.set(tenantId, Date.now());
      for (const res of this.clients.get(tenantId) || []) res.write('event: board\ndata: {}\n\n');
    }, wait));
  }

  /** Opens an SSE stream for one viewer of one tenant's board. */
  subscribe(tenantId, req, res) {
    this.start();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`retry: 5000\nevent: ready\ndata: {"live":${this.enabled}}\n\n`);
    if (!this.clients.has(tenantId)) this.clients.set(tenantId, new Set());
    this.clients.get(tenantId).add(res);
    req.on('close', () => {
      const set = this.clients.get(tenantId);
      if (!set) return;
      set.delete(res);
      if (!set.size) this.clients.delete(tenantId);
    });
  }

  viewers(tenantId) { return (this.clients.get(tenantId) || new Set()).size; }
}

module.exports = { LiveBoard, CHANNEL };
