import { randomUUID, createHash } from 'node:crypto';
import { LinkError } from './transport.js';
import { ContentStore } from './content.js';

const fail = message => { throw new LinkError('INVALID_PARAMS', message); };
function params(value, keys) {
  const p = value ?? {};
  if (typeof p !== 'object' || Array.isArray(p)) fail('Expected an object');
  for (const key of Object.keys(p)) if (!keys.includes(key)) fail(`Unknown field: ${key}`);
  return p;
}
function text(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /\0/.test(value)) fail(`Invalid ${name}`);
  return value;
}
function id(value, name = 'sessionId') {
  text(value, name, 128);
  if (/[\\/]/.test(value) || value === '.' || value === '..') fail(`Invalid ${name}`);
  return value;
}
function integer(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
function address(p) {
  if (p.address !== undefined && p.sessionId !== undefined) fail('Use sessionId or address');
  if (p.address === undefined) return { kind: 'session', sessionId: id(p.sessionId) };
  const a = p.address;
  if (!a || typeof a !== 'object' || Array.isArray(a)) fail('Invalid address');
  if (a.kind === 'session') { params(a, ['kind', 'sessionId']); return { kind: 'session', sessionId: id(a.sessionId) }; }
  params(a, ['kind', 'parentSessionId', 'childSessionId', 'mode']);
  if (a.kind !== 'subagent' || !['one-shot', 'continuable', 'unknown'].includes(a.mode)) fail('Invalid subagent address');
  return { kind: a.kind, parentSessionId: id(a.parentSessionId), childSessionId: id(a.childSessionId), mode: a.mode };
}
function nativeError(error) {
  if (error instanceof LinkError) return error;
  const code = error?.code;
  if (typeof code === 'string' && /^(session\/|subagent\/|agent-preset\/|workspace\/|gateway\/bad-request$)/.test(code)) {
    return new LinkError(code, typeof error.message === 'string' ? error.message.slice(0, 1024) : 'DSH operation rejected');
  }
  if (error?.constructor?.name === 'ApiSessionNotFound') return new LinkError('session/not-found', 'Session not found');
  if (error?.name === 'AbortError') return new LinkError('CANCELLED', 'Operation cancelled');
  return new LinkError('INTERNAL_ERROR', 'DSH operation failed');
}

/** Adapter for the host's existing SessionController; never parses JSONL itself. */
export class ChatBridge {
  constructor(ctx, link) {
    this.ctx = ctx; this.link = link; this.controller = ctx.sessionController;
    this.content = new ContentStore({ inlineBytes: Math.min(131072, Math.max(128, link.config.maxPayloadBytes - 8192)),
      chunkBytes: Math.min(49152, Math.max(1, Math.floor((link.config.maxPayloadBytes - 1024) * .7))) });
    this.subscriptions = new Map(); this.lists = new Map(); this.prompts = new Map(); this.disposers = []; this.pumps = new Set();
    this.onState = ({ state }) => { if (state !== 'ready') this.reset(); };
    link.on('state', this.onState);
    this.install();
    for (const [event, change] of Object.entries({ 'api-session/added': 'added', 'api-session/removed': 'removed',
      'api-session/status': 'status', 'api-session/activity': 'activity', 'api-session/error': 'error' })) {
      this.disposers.push(ctx.on(event, value => {
        const sessionId = typeof value === 'string' ? value : value.sessionId;
        link.publish('session.list.changed', { sessionId, change });
      }, { global: true }));
    }
  }
  register(name, handler) {
    this.disposers.push(this.link.registerMethod(name, async (p, request) => {
      request.signal.throwIfAborted();
      try { return await handler(p, request); } catch (error) { throw nativeError(error); }
    }));
  }
  reset() {
    for (const entry of this.subscriptions.values()) entry.controller.abort();
    this.subscriptions.clear(); this.content.clear(); this.lists.clear();
  }
  async dispose() {
    const pumps = [...this.pumps];
    this.link.off('state', this.onState); this.reset();
    for (const dispose of this.disposers.reverse()) dispose();
    this.prompts.clear(); await Promise.allSettled(pumps);
  }
  async inspect(a, signal) {
    if (a.kind === 'subagent') await this.controller.page({ address: a, throughSeq: -1, maxMessages: 1 }, signal);
    const result = await this.controller.inspect(a.kind === 'session' ? a.sessionId : a.childSessionId, signal);
    if (a.kind === 'session' && result.meta.origin === 'subagent') throw new LinkError('SUBAGENT_ADDRESS_REQUIRED', 'Supply the subagent parent address');
    return result;
  }
  install() {
    const c = this.controller, pack = value => this.content.pack(value);
    this.register('content.read', p => { p = params(p, ['contentId', 'offset', 'length']); return this.content.read(text(p.contentId, 'contentId', 128), p.offset, p.length); });
    this.register('content.release', p => { p = params(p, ['contentId']); return { released: this.content.release(text(p.contentId, 'contentId', 128)) }; });
    this.register('session.list', async (p, r) => {
      p = params(p, ['limit', 'cursor']); const limit = integer(p.limit, 'limit', 1, 100, 50);
      const now = Date.now(); for (const [key, entry] of this.lists) if (entry.expiresAt <= now) this.lists.delete(key);
      let entry, key, offset = 0;
      if (p.cursor !== undefined) {
        try {
          const cursor = JSON.parse(Buffer.from(text(p.cursor, 'cursor', 512), 'base64url').toString());
          key = cursor.id; offset = integer(cursor.offset, 'cursor offset', 0, Number.MAX_SAFE_INTEGER, undefined);
          if (typeof key !== 'string' || offset === undefined) fail('Invalid cursor');
        } catch { fail('Invalid cursor'); }
        entry = this.lists.get(key);
        if (!entry) throw new LinkError('CURSOR_EXPIRED', 'Repeat the initial list read');
        if (offset > entry.items.length) fail('Cursor past list end');
      } else {
        const result = await c.list({}, r.signal);
        // Detached snapshot preserves stable pagination during concurrent title/activity changes.
        const encoded = JSON.stringify(result.items);
        if (Buffer.byteLength(encoded) > 8388608) throw new LinkError('RESOURCE_LIMIT', 'Session list snapshot exceeds capacity');
        entry = { items: JSON.parse(encoded), expiresAt: now + 300000 }; key = randomUUID();
        while (this.lists.size >= 8) this.lists.delete(this.lists.keys().next().value);
        this.lists.set(key, entry);
      }
      const end = Math.min(offset + limit, entry.items.length), hasMore = end < entry.items.length;
      return pack({ items: entry.items.slice(offset, end), hasMore,
        nextCursor: hasMore ? Buffer.from(JSON.stringify({ id: key, offset: end })).toString('base64url') : null });
    });
    this.register('session.get', async (p, r) => {
      p = params(p, ['sessionId', 'address']); const a = address(p), result = await this.inspect(a, r.signal);
      const sessionId = result.meta.id;
      return pack({ header: result.meta, cursor: result.events.at(-1)?.seq ?? -1,
        projections: await c.projections({ sessionId }, r.signal), running: this.ctx.get('agents')?.get(sessionId)?.status === 'running' });
    });
    this.register('session.page', async (p, r) => {
      p = params(p, ['sessionId', 'address', 'throughSeq', 'beforeSeq', 'maxMessages']); const a = address(p);
      const throughSeq = integer(p.throughSeq, 'throughSeq', -1, Number.MAX_SAFE_INTEGER,
        p.throughSeq === undefined ? (await this.inspect(a, r.signal)).events.at(-1)?.seq ?? -1 : undefined);
      const request = { address: a, throughSeq, maxMessages: integer(p.maxMessages, 'maxMessages', 1, 100, 50) };
      if (p.beforeSeq !== undefined) request.beforeSeq = integer(p.beforeSeq, 'beforeSeq', 0, Number.MAX_SAFE_INTEGER);
      const page = await c.page(request, r.signal);
      return pack({ ...page, throughSeq, nextBeforeSeq: page.hasMore ? page.records[0]?.event.seq ?? null : null });
    });
    this.register('session.events', async (p, r) => {
      p = params(p, ['sessionId', 'address', 'afterSeq', 'throughSeq', 'limit']); const source = await this.inspect(address(p), r.signal);
      const latest = source.events.at(-1)?.seq ?? -1;
      const throughSeq = integer(p.throughSeq, 'throughSeq', -1, latest, latest);
      const afterSeq = integer(p.afterSeq, 'afterSeq', -1, Number.MAX_SAFE_INTEGER, -1);
      if (afterSeq > throughSeq) throw new LinkError('CURSOR_AHEAD', 'Cursor exceeds the requested log cut');
      const limit = integer(p.limit, 'limit', 1, 200, 100);
      const events = source.events.slice(afterSeq + 1, Math.min(throughSeq + 1, afterSeq + 1 + limit));
      const nextAfterSeq = events.at(-1)?.seq ?? afterSeq;
      return pack({ records: events.map(event => ({ type: 'event', event })), throughSeq, nextAfterSeq, hasMore: nextAfterSeq < throughSeq });
    });
    this.register('session.event', async (p, r) => {
      p = params(p, ['sessionId', 'address', 'seq']); const seq = integer(p.seq, 'seq', 0, Number.MAX_SAFE_INTEGER);
      if (seq === undefined) fail('seq required');
      const source = await this.inspect(address(p), r.signal), event = source.events[seq];
      if (!event || event.seq !== seq) throw new LinkError('EVENT_NOT_FOUND', 'Event not found');
      return pack({ type: 'event', event });
    });
    this.register('session.projections', async (p, r) => { p = params(p, ['sessionId']); return pack(await c.projections({ sessionId: id(p.sessionId) }, r.signal)); });
    this.register('session.attachment', async p => { p = params(p, ['sessionId', 'attachmentId']); return pack(await c.attachment({ sessionId: id(p.sessionId), attachmentId: id(p.attachmentId, 'attachmentId') })); });
    this.register('model.catalog', async p => { params(p, []); return pack(await c.modelCatalog()); });
    this.register('session.create', async p => {
      p = params(p, ['sessionId', 'cwd', 'workspaceId', 'agentPreset']); const request = {};
      if (p.cwd !== undefined && p.workspaceId !== undefined) fail('Use cwd or workspaceId');
      if (p.sessionId !== undefined) request.sessionId = id(p.sessionId);
      if (p.cwd !== undefined) request.cwd = text(p.cwd, 'cwd', 32768);
      if (p.workspaceId !== undefined) request.workspaceId = id(p.workspaceId, 'workspaceId');
      if (p.agentPreset !== undefined) request.agentPreset = text(p.agentPreset, 'agentPreset');
      return c.create(request);
    });
    this.register('session.rename', p => { p = params(p, ['sessionId', 'title']); return c.rename({ sessionId: id(p.sessionId), title: text(p.title, 'title', 4096) }); });
    this.register('session.fork', p => {
      p = params(p, ['sessionId', 'atSeq']); const request = { sessionId: id(p.sessionId) };
      if (p.atSeq !== undefined) request.atSeq = integer(p.atSeq, 'atSeq', 0, Number.MAX_SAFE_INTEGER);
      return c.fork(request);
    });
    this.register('session.selectModel', p => {
      p = params(p, ['sessionId', 'provider', 'model', 'reasoningEffort']);
      const request = { sessionId: id(p.sessionId), provider: text(p.provider, 'provider'), model: text(p.model, 'model') };
      if (p.reasoningEffort !== undefined) request.reasoningEffort = text(p.reasoningEffort, 'reasoningEffort');
      return c.selectModel(request);
    });
    this.register('session.prompt', (p, r) => this.prompt(p, r));
    this.register('session.cancel', p => { p = params(p, ['sessionId']); return c.cancel({ sessionId: id(p.sessionId) }); });
    this.register('session.queue.update', p => {
      p = params(p, ['sessionId', 'itemId', 'action']); const action = params(p.action, ['kind', 'content']);
      if (!['edit', 'remove', 'steer'].includes(action.kind)) fail('Invalid queue action');
      const value = { kind: action.kind };
      if (action.kind === 'edit') value.content = this.parts(action.content, true);
      else if (action.content !== undefined) fail('content only valid for edit');
      return c.updateQueue({ sessionId: id(p.sessionId), itemId: id(p.itemId, 'itemId'), action: value });
    });
    this.register('session.subscribe', (p, r) => this.subscribe(p, r));
    this.register('session.unsubscribe', p => {
      p = params(p, ['subscriptionId']); const key = id(p.subscriptionId, 'subscriptionId'), entry = this.subscriptions.get(key);
      if (entry) { this.subscriptions.delete(key); entry.controller.abort(); }
      return { unsubscribed: !!entry };
    });
  }
  parts(value, textOnly = false) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 256) fail('Invalid content parts');
    let meaningful = false;
    const parts = value.map(part => {
      if (part?.type === 'text') {
        params(part, ['type', 'text']); if (typeof part.text !== 'string') fail('Invalid text');
        meaningful ||= !!part.text.trim(); return { type: 'text', text: part.text };
      }
      if (textOnly) fail('Only text parts are supported for queue edits');
      if (part?.type === 'image') {
        params(part, ['type', 'mediaType', 'data', 'name']);
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mediaType)) fail('Invalid image mediaType');
        const image = { type: 'image', mediaType: part.mediaType, data: text(part.data, 'image data', 262144) };
        if (part.name !== undefined) image.name = text(part.name, 'image name'); meaningful = true; return image;
      }
      if (part?.type === 'file') { params(part, ['type', 'receiptId']); meaningful = true; return { type: 'file', receiptId: id(part.receiptId, 'receiptId') }; }
      fail('Unknown content part');
    });
    if (!meaningful) fail('Prompt content is empty'); return parts;
  }
  async prompt(input, request) {
    const p = params(input, ['sessionId', 'clientRequestId', 'content', 'mode', 'clientTimeZone']);
    const sessionId = id(p.sessionId), clientRequestId = id(p.clientRequestId, 'clientRequestId');
    const mode = p.mode ?? 'queue'; if (!['queue', 'steer'].includes(mode)) fail('Invalid prompt mode');
    const native = { sessionId, requestId: clientRequestId, content: this.parts(p.content), mode };
    if (p.clientTimeZone !== undefined) native.clientTimeZone = text(p.clientTimeZone, 'clientTimeZone', 128);
    const fingerprint = createHash('sha256').update(JSON.stringify(native)).digest('hex'), key = JSON.stringify([sessionId, clientRequestId]);
    const prior = this.prompts.get(key);
    if (prior && prior.fingerprint !== fingerprint) throw new LinkError('ID_CONFLICT', 'clientRequestId reused with different content');
    if (prior) { await prior.promise; return { accepted: true, clientRequestId }; }
    if (this.prompts.size >= 1024) {
      for (const [key, entry] of this.prompts) if (entry.done) { this.prompts.delete(key); break; }
      if (this.prompts.size >= 1024) throw new LinkError('BUSY', 'Prompt admissions full');
    }
    const entry = { fingerprint, done: false };
    entry.promise = Promise.resolve().then(() => {
      request.signal.throwIfAborted(); return this.controller.prompt(native, request.signal);
    });
    this.prompts.set(key, entry);
    try { await entry.promise; entry.done = true; return { accepted: true, clientRequestId }; }
    catch (error) { if (this.prompts.get(key) === entry) this.prompts.delete(key); throw error; }
  }
  async subscribe(input, request) {
    const p = params(input, ['subscriptionId', 'sessionId', 'address', 'afterSeq', 'maxMessages']);
    const key = id(p.subscriptionId, 'subscriptionId'), a = address(p);
    if (this.subscriptions.has(key)) throw new LinkError('SUBSCRIPTION_EXISTS', 'Subscription ID already in use');
    if (this.subscriptions.size >= 32) throw new LinkError('BUSY', 'Subscription limit reached');
    const entry = { controller: new AbortController(), connectionId: this.link.connectionId };
    this.subscriptions.set(key, entry);
    const cancel = () => entry.controller.abort(); request.signal.addEventListener('abort', cancel, { once: true });
    try {
      request.signal.throwIfAborted();
      entry.iterator = this.controller.follow({ address: a, maxMessages: integer(p.maxMessages, 'maxMessages', 1, 100, 50), assistantStream: true }, entry.controller.signal)[Symbol.asyncIterator]();
      const first = await entry.iterator.next();
      if (first.done || first.value.type !== 'snapshot') throw new LinkError('INTERNAL_ERROR', 'Missing opening snapshot');
      entry.controller.signal.throwIfAborted(); request.signal.throwIfAborted();
      const snapshot = first.value;
      const afterSeq = integer(p.afterSeq, 'afterSeq', -1, Number.MAX_SAFE_INTEGER, undefined);
      if (afterSeq !== undefined && afterSeq > snapshot.cursor) throw new LinkError('CURSOR_AHEAD', 'Cursor exceeds current log');
      const result = { subscriptionId: key, opening: this.content.pack(snapshot),
        replay: afterSeq !== undefined && afterSeq < snapshot.cursor ? { afterSeq, throughSeq: snapshot.cursor } : null };
      entry.pump = new Promise(resolve => setImmediate(resolve)).then(() => this.pump(key, entry));
      this.pumps.add(entry.pump);
      entry.pump.then(() => this.pumps.delete(entry.pump), () => this.pumps.delete(entry.pump));
      return result;
    } catch (error) {
      entry.controller.abort(); if (this.subscriptions.get(key) === entry) this.subscriptions.delete(key);
      try { await entry.iterator?.return?.(); } catch {} throw error;
    } finally { request.signal.removeEventListener('abort', cancel); }
  }
  async pump(key, entry) {
    try {
      while (!entry.controller.signal.aborted) {
        const next = await entry.iterator.next(); if (next.done || entry.controller.signal.aborted) break;
        if (this.link.connectionId !== entry.connectionId || this.link.state !== 'ready') break;
        const sent = this.link.publish('session.follow', { subscriptionId: key, frame: this.content.pack(next.value) });
        if (!sent) break;
      }
      if (!entry.controller.signal.aborted && this.link.connectionId === entry.connectionId) this.link.publish('session.subscription.end', { subscriptionId: key });
    } catch (error) {
      if (!entry.controller.signal.aborted && this.link.connectionId === entry.connectionId) {
        const safe = nativeError(error); this.link.publish('session.subscription.end', { subscriptionId: key, error: { code: safe.code, message: safe.message } });
      }
    } finally {
      entry.controller.abort(); try { await entry.iterator.return?.(); } catch {}
      if (this.subscriptions.get(key) === entry) this.subscriptions.delete(key);
    }
  }
}
