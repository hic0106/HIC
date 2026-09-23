// Binance USDT-M User Data Stream (listenKey) on the routed /private WebSocket path.
//   POST /fapi/v1/listenKey (valid 60 min) -> wss://.../private/stream?streams=<listenKey>
//   PUT every 30 min keeps it alive; on close / expiry a new key is requested and the caller re-reads REST
//   (snapshot recovery), so a gap in the stream never leaves stale balances or positions.
// Events: 'account' (ACCOUNT_UPDATE.a), 'order' (ORDER_TRADE_UPDATE.o), 'connected', 'disconnected'.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

const KEEPALIVE_MS = 30 * 60_000;

export class UserDataStream extends EventEmitter {
  constructor({ getClient, wsBase, log, WebSocketImpl = WebSocket }) {
    super();
    this.getClient = getClient;
    this.wsBase = wsBase;
    this.log = log;
    this.WS = WebSocketImpl;
    this.running = false;
    this.status = 'OFF';
    this.ws = null;
    this.retry = 0;
    this.lastEventAt = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.keepTimer = setInterval(() => this.keepalive(), KEEPALIVE_MS);
    this.keepTimer.unref?.();
  }

  async stop() {
    this.running = false;
    clearInterval(this.keepTimer);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    if (this.listenKey) { try { await this.getClient().closeUserStream(); } catch { /* expired anyway */ } }
    this.listenKey = null;
    this.status = 'OFF';
  }

  async connect() {
    if (!this.running) return;
    this.status = 'CONNECTING';
    let key;
    try {
      key = (await this.getClient().startUserStream()).listenKey;
    } catch (e) {
      this.status = 'ERROR';
      this.log.warn(`User data stream listenKey failed: ${e.message} — REST polling continues`, 'USER_STREAM');
      return this.scheduleReconnect();
    }
    this.listenKey = key;
    const ws = new this.WS(`${this.wsBase}/private/stream?streams=${key}`);
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      this.status = 'CONNECTED';
      this.log.info('User data stream connected (balances / positions / fills / funding pushed live)', 'USER_STREAM');
      this.emit('connected');
    });
    ws.on('message', (buf) => {
      try { this.onMessage(JSON.parse(buf)); } catch (e) { this.log.warn(`user stream parse error: ${e.message}`, 'USER_STREAM'); }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.status = 'DISCONNECTED';
      this.emit('disconnected');
      if (this.running) { this.log.warn('User data stream disconnected — reconnecting (REST snapshot used meanwhile)', 'USER_STREAM'); this.scheduleReconnect(); }
    });
    ws.on('error', (e) => this.log.warn(`User data stream error: ${e.message}`, 'USER_STREAM'));
  }

  scheduleReconnect() {
    if (!this.running) return;
    const delay = Math.min(60_000, 2000 * 2 ** this.retry++);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
  }

  async keepalive() {
    if (!this.running || !this.listenKey) return;
    try { await this.getClient().keepaliveUserStream(); } catch (e) {
      this.log.warn(`listenKey keepalive failed: ${e.message} — reconnecting`, 'USER_STREAM');
      this.reconnectNow();
    }
  }

  reconnectNow() {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* ignore */ }
    this.status = 'DISCONNECTED';
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  onMessage(msg) {
    const d = msg?.data ?? msg;
    if (!d || !d.e) return;
    this.lastEventAt = Date.now();
    if (d.e === 'ACCOUNT_UPDATE') this.emit('account', d.a || {}, d);
    else if (d.e === 'ORDER_TRADE_UPDATE') this.emit('order', d.o || {}, d);
    else if (d.e === 'listenKeyExpired') { this.log.warn('listenKey expired — requesting a new one', 'USER_STREAM'); this.reconnectNow(); }
  }
}
