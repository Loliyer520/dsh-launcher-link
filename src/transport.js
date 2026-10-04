import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import WebSocket from 'ws';
import { resolveConfig, VERSION, PROTOCOL } from './config.js';

export class LinkError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const timer = (fn, ms) => { const value = setTimeout(fn, ms); value.unref(); return value; };

/** One outbound link; it never opens a listening port or retries commands. */
export class LauncherLink extends EventEmitter {
  constructor(config = {}, options = {}) {
    super();
    this.config = resolveConfig(config, options.env ?? process.env);
    this.WebSocket = options.WebSocket ?? WebSocket;
    this.random = options.random ?? Math.random;
    this.methods = new Map();
    this.state = this.config.url ? 'stopped' : 'disabled';
    this.running = false;
    this.socket = null;
    this.connectionId = null;
    this.attempt = 0;
    this.sequence = 0;
    this.requests = new Map();
    this.cache = new Map();
    this.registerMethod('system.ping', () => ({ time: new Date().toISOString() }));
    this.registerMethod('instance.info', () => this.info());
  }

  info() {
    return { instanceId: this.config.instanceId, label: this.config.label, profile: this.config.profile,
      pid: process.pid, pluginVersion: VERSION, protocol: PROTOCOL, methods: [...this.methods.keys()].sort(), state: this.state };
  }

  setState(state) {
    if (state === this.state) return;
    this.state = state;
    this.emit('state', { state, instanceId: this.config.instanceId });
  }

  registerMethod(name, handler) {
    if (!/^[a-zA-Z][\w.-]{0,127}$/.test(name) || typeof handler !== 'function') throw new Error('Invalid method');
    if (this.methods.has(name)) throw new Error(`Method already registered: ${name}`);
    this.methods.set(name, handler);
    this.publish('capabilities.changed', { methods: [...this.methods.keys()].sort() });
    return () => {
      if (this.methods.get(name) !== handler) return;
      this.methods.delete(name);
      this.publish('capabilities.changed', { methods: [...this.methods.keys()].sort() });
    };
  }

  start() {
    if (this.running || !this.config.url) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.clearConnection();
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    this.setState(this.config.url ? 'stopped' : 'disabled');
  }

  clearConnection() {
    clearTimeout(this.handshakeTimer);
    clearInterval(this.heartbeatTimer);
    this.pendingPing = null;
    for (const request of this.requests.values()) request.controller.abort(new LinkError('DISCONNECTED', 'Link disconnected'));
    this.requests.clear();
    this.cache.clear();
  }

  connect() {
    if (!this.running) return;
    this.connectionId = randomUUID();
    this.setState('connecting');
    let socket;
    try {
      socket = new this.WebSocket(this.config.url, PROTOCOL, {
        headers: { Authorization: `Bearer ${this.config.token}` },
        handshakeTimeout: this.config.handshakeTimeoutMs,
        maxPayload: this.config.maxPayloadBytes,
        perMessageDeflate: false,
        followRedirects: false,
      });
    } catch { this.scheduleReconnect(); return; }
    this.socket = socket;
    let rejected = false;
    socket.on('upgrade', response => {
      if (response.headers['sec-websocket-protocol'] !== PROTOCOL) rejected = true;
    });
    socket.on('unexpected-response', (_request, response) => {
      rejected = response.statusCode === 401 || response.statusCode === 403;
      response.resume();
      socket.terminate();
    });
    socket.on('error', () => { /* Error details may contain a credential-bearing request; never log them. */ });
    socket.on('open', () => {
      if (socket !== this.socket || !this.running) { socket.terminate(); return; }
      if (socket.protocol !== PROTOCOL) { rejected = true; socket.close(1002, 'Subprotocol required'); return; }
      this.setState('handshaking');
      this.send({ type: 'hello', connectionId: this.connectionId, instance: this.info(),
        capabilities: { requests: true, events: true, replay: false } });
      this.handshakeTimer = timer(() => socket.terminate(), this.config.handshakeTimeoutMs);
    });
    socket.on('message', (data, binary) => {
      if (socket !== this.socket || !this.running) return;
      if (binary) { socket.close(1003, 'JSON text required'); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1007, 'Invalid JSON'); return; }
      if (!object(message) || message.v !== 1) { socket.close(1002, 'Unsupported protocol'); return; }
      if (this.state === 'handshaking') {
        if (message.type === 'reject') { rejected = true; socket.close(4003, 'Registration rejected'); return; }
        if (message.type !== 'welcome' || message.connectionId !== this.connectionId || message.instanceId !== this.config.instanceId) {
          rejected = true; socket.close(1002, 'Invalid welcome'); return;
        }
        clearTimeout(this.handshakeTimer);
        this.attempt = 0;
        this.setState('ready');
        // Methods may have been installed after hello while publish was disabled.
        // Always reconcile the complete list after the welcome boundary.
        this.publish('capabilities.changed', { methods: [...this.methods.keys()].sort() });
        this.startHeartbeat(socket);
        this.emit('ready', this.info());
        return;
      }
      if (this.state !== 'ready') return;
      if (message.type === 'pong') {
        if (message.id === this.pendingPing?.id) this.pendingPing = null;
      } else if (message.type === 'ping' && validId(message.id)) {
        this.send({ type: 'pong', id: message.id });
      } else if (message.type === 'request') {
        this.handleRequest(message, socket);
      } else if (message.type === 'cancel' && validId(message.id)) {
        this.requests.get(message.id)?.controller.abort(new LinkError('CANCELLED', 'Request cancelled'));
      } else {
        socket.close(1002, 'Unexpected frame');
      }
    });
    socket.on('close', code => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearConnection();
      if (!this.running) return;
      if (rejected || [4001, 4003, 4009].includes(code)) {
        this.running = false;
        this.setState('rejected');
        return;
      }
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (!this.running) return;
    this.setState('reconnecting');
    const base = Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** Math.min(this.attempt++, 16));
    const delay = Math.min(this.config.reconnectMaxMs, Math.round(base * (.8 + this.random() * .4)));
    this.reconnectTimer = timer(() => this.connect(), delay);
  }

  startHeartbeat(socket) {
    this.heartbeatTimer = setInterval(() => {
      if (socket !== this.socket || this.state !== 'ready') return;
      if (this.pendingPing) {
        if (Date.now() - this.pendingPing.sentAt >= this.config.heartbeatTimeoutMs) socket.terminate();
        return;
      }
      this.pendingPing = { id: randomUUID(), sentAt: Date.now() };
      this.send({ type: 'ping', id: this.pendingPing.id });
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  send(frame) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    let data;
    try { data = JSON.stringify({ v: 1, ...frame }); } catch { return false; }
    if (Buffer.byteLength(data) > this.config.maxPayloadBytes || socket.bufferedAmount + Buffer.byteLength(data) > this.config.maxBufferedBytes) {
      socket.terminate();
      return false;
    }
    socket.send(data, error => { if (error) socket.terminate(); });
    return true;
  }

  publish(event, data = null) {
    if (this.state !== 'ready') return false;
    if (typeof event !== 'string' || !/^[a-zA-Z][\w.-]{0,127}$/.test(event)) throw new Error('Invalid event');
    return this.send({ type: 'event', instanceId: this.config.instanceId, connectionId: this.connectionId,
      seq: ++this.sequence, event, data });
  }

  async handleRequest(message, socket) {
    const { id, method, params = null } = message;
    const respond = frame => { if (socket === this.socket && this.state === 'ready') this.send(frame); };
    const failure = (code, description) => ({ type: 'response', id, ok: false, error: { code, message: description } });
    if (!validId(id)) { socket.close(1002, 'Invalid request ID'); return; }
    if (typeof method !== 'string' || method.length > 128) { respond(failure('INVALID_REQUEST', 'Invalid method')); return; }
    const fingerprint = createHash('sha256').update(JSON.stringify([method, params])).digest('hex');
    const previous = this.cache.get(id) ?? this.requests.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) respond(failure('ID_CONFLICT', 'Request ID reused with different payload'));
      else if (previous.response) respond(previous.response);
      return;
    }
    const handler = this.methods.get(method);
    if (!handler) { respond(failure('METHOD_NOT_FOUND', 'Method not registered')); return; }
    if (this.requests.size >= this.config.maxConcurrentRequests) { respond(failure('BUSY', 'Too many requests')); return; }
    const controller = new AbortController();
    const entry = { controller, fingerprint };
    this.requests.set(id, entry);
    const expiry = timer(() => controller.abort(new LinkError('TIMEOUT', 'Request timed out')), this.config.requestTimeoutMs);
    let abortListener;
    let response;
    try {
      const aborted = new Promise((_resolve, reject) => {
        abortListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      const result = await Promise.race([Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return handler(params, {
          signal: controller.signal, requestId: id, instanceId: this.config.instanceId,
          publish: (event, data) => !controller.signal.aborted && socket === this.socket && this.publish(event, data),
        });
      }), aborted]);
      response = { type: 'response', id, ok: true, result: result ?? null };
      let encoded;
      try { encoded = JSON.stringify(response); } catch { throw new LinkError('INVALID_RESULT', 'Result must be JSON serializable'); }
      if (Buffer.byteLength(encoded) > this.config.maxPayloadBytes - 16) throw new LinkError('RESULT_TOO_LARGE', 'Result exceeds frame limit');
    } catch (error) {
      response = failure(error instanceof LinkError ? error.code : 'INTERNAL_ERROR', error instanceof LinkError ? error.message : 'Request failed');
    } finally {
      clearTimeout(expiry);
      controller.signal.removeEventListener('abort', abortListener);
      if (this.requests.get(id) === entry) this.requests.delete(id);
    }
    if (socket !== this.socket || this.state !== 'ready') return;
    this.cache.set(id, { fingerprint, response });
    while (this.cache.size > this.config.requestCacheSize) this.cache.delete(this.cache.keys().next().value);
    respond(response);
  }
}
