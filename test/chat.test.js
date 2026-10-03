import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { LauncherLink } from '../src/transport.js';
import { ChatBridge } from '../src/chat.js';
import { ContentStore } from '../src/content.js';
import { createMockLauncher } from '../examples/mock-launcher.mjs';

function wait(emitter, event, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const listener = value => { if (predicate(value)) { clearTimeout(expiry); emitter.off(event, listener); resolve(value); } };
    const expiry = setTimeout(() => { emitter.off(event, listener); reject(new Error(`Timeout: ${event}`)); }, 3000);
    emitter.on(event, listener);
  });
}
function fixture() {
  const events = [
    { seq: 0, type: 'user/message', time: 1, surfaceOp: 'append', data: { id: 'user-1', content: [{ type: 'text', text: '中文😀' }] } },
    { seq: 1, type: 'assistant/message', time: 2, surfaceOp: 'append', data: { id: 'assistant-1', content: [
      { type: 'reasoning', text: '推理' }, { type: 'text', text: '答案' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: { path: 'a' } },
      { type: 'image', attachment: { id: 'img-1', mediaType: 'image/png' } }] } },
    { seq: 2, type: 'tool/result', time: 3, surfaceOp: 'append', data: { callId: 'call-1', content: [{ type: 'text', text: '工具输出' }], status: 'success' } },
  ];
  const bus = new EventEmitter(), updates = new EventEmitter();
  const sessions = new Map([['session-1', { id: 'session-1', cwd: 'C:/test' }]]);
  const state = { prompts: [], cancelled: [], queued: [], follows: 0, closed: 0 };
  const controller = {
    async inspect(sessionId) { if (!sessions.has(sessionId)) throw { code: 'session/not-found', message: 'Missing' }; return { meta: sessions.get(sessionId), events }; },
    async list() { return { items: [...sessions.values()].map(meta => ({ sessionId: meta.id, updatedAt: 1, projections: { title: '会话' } })) }; },
    async projections() { return { asOfSeq: events.length - 1, values: { model: { name: 'fake' } } }; },
    async page(request) { if (request.address.kind === 'subagent' && request.address.parentSessionId !== 'session-1') throw { code: 'subagent/unauthorized', message: 'Parent mismatch' };
      const end = Math.min(request.throughSeq + 1, request.beforeSeq ?? events.length); const start = Math.max(0, end - request.maxMessages);
      return { records: events.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 }; },
    async create(p) { const sessionId = p.sessionId ?? 'new-session'; sessions.set(sessionId, { id: sessionId, cwd: p.cwd ?? 'C:/test' }); return { sessionId }; },
    async rename(p) { state.renamed = p; return { title: p.title, seq: 3 }; },
    async fork(p) { state.forked = p; return { sessionId: 'forked' }; },
    async selectModel(p) { state.model = p; return { selected: p }; },
    async prompt(p) { state.prompts.push(p); return { accepted: true }; },
    cancel(p) { state.cancelled.push(p); return { accepted: true }; },
    updateQueue(p) { state.queued.push(p); return { accepted: true }; },
    async attachment() { return { attachment: { id: 'img-1' }, data: Buffer.from('image fixture').toString('base64') }; },
    async modelCatalog() { return { groups: [{ id: 'test', models: [{ id: 'fake' }] }] }; },
    async *follow(request, signal) {
      state.follows++; const queue = []; let wake;
      const listener = frame => { queue.push(frame); wake?.(); }, onAbort = () => wake?.();
      updates.on('frame', listener); signal.addEventListener('abort', onAbort);
      try {
        yield { type: 'snapshot', header: sessions.get(request.address.sessionId), cursor: events.at(-1).seq,
          records: events.map(event => ({ type: 'event', event })), hasMore: false, projections: { asOfSeq: 2, values: {} }, assistantStream: { revision: 0 } };
        while (!signal.aborted) {
          if (queue.length) yield queue.shift(); else await new Promise(resolve => { wake = resolve; });
        }
      } finally { updates.off('frame', listener); signal.removeEventListener('abort', onAbort); state.closed++; }
    },
  };
  const ctx = { sessionController: controller, get: () => undefined,
    on(event, fn) { bus.on(event, fn); return () => bus.off(event, fn); } };
  return { ctx, events, sessions, state, updates, bus };
}
async function setup(t) {
  const launcher = await createMockLauncher({ token: 'chat-test-only-not-production' });
  const link = new LauncherLink({ url: launcher.url, token: 'chat-test-only-not-production', instanceId: 'chat-test', reconnectMinMs: 10, reconnectMaxMs: 20 }, { env: {} });
  const f = fixture(), bridge = new ChatBridge(f.ctx, link);
  t.after(async () => { link.stop(); await bridge.dispose(); await launcher.close(); });
  const ready = wait(link, 'ready'); link.start(); await ready;
  let sequence = 0;
  async function rpc(method, params = {}) {
    const id = `request-${++sequence}`;
    const response = wait(launcher.wss, 'frame', f => f.message.type === 'response' && f.message.id === id);
    launcher.send('chat-test', { type: 'request', id, method, params }); return (await response).message;
  }
  async function call(method, params) { const response = await rpc(method, params); assert.equal(response.ok, true, JSON.stringify(response.error)); return response.result; }
  return { ...f, launcher, link, bridge, rpc, call };
}

test('complete native history, stable list paging and event cut pagination', async t => {
  const f = await setup(t); f.sessions.set('session-2', { id: 'session-2', cwd: 'C:/test' });
  const first = (await f.call('session.list', { limit: 1 })).value;
  f.sessions.delete('session-2');
  const last = (await f.call('session.list', { cursor: first.nextCursor, limit: 1 })).value;
  assert.equal(last.items[0].sessionId, 'session-2'); assert.equal(last.hasMore, false);
  const get = (await f.call('session.get', { sessionId: 'session-1' })).value;
  assert.equal(get.cursor, 2); assert.equal(get.header.cwd, 'C:/test');
  const page = (await f.call('session.page', { sessionId: 'session-1', maxMessages: 2 })).value;
  assert.deepEqual(page.records[0].event, f.events[1]); assert.equal(page.nextBeforeSeq, 1);
  const older = (await f.call('session.page', { sessionId: 'session-1', throughSeq: page.throughSeq, beforeSeq: page.nextBeforeSeq })).value;
  assert.equal(older.records[0].event.seq, 0);
  const prefix = (await f.call('session.events', { sessionId: 'session-1', afterSeq: -1, limit: 2 })).value;
  const suffix = (await f.call('session.events', { sessionId: 'session-1', afterSeq: prefix.nextAfterSeq, throughSeq: prefix.throughSeq })).value;
  assert.deepEqual([...prefix.records, ...suffix.records].map(r => r.event), f.events);
  assert.deepEqual((await f.call('session.event', { sessionId: 'session-1', seq: 1 })).value.event, f.events[1]);
  assert.equal((await f.rpc('session.events', { sessionId: 'session-1', afterSeq: 10 })).error.code, 'CURSOR_AHEAD');
});

test('long Chinese/emoji message round-trips losslessly with SHA256', async t => {
  const f = await setup(t); f.events[1].data.content[1].text = '完整中文😀🧪'.repeat(25000);
  const payload = await f.call('session.event', { sessionId: 'session-1', seq: 1 });
  assert.equal(payload.kind, 'content-ref');
  const buffers = []; let offset = 0;
  while (offset < payload.totalBytes) {
    const chunk = await f.call('content.read', { contentId: payload.contentId, offset });
    assert.ok(chunk.nextOffset - offset <= 49152); buffers.push(Buffer.from(chunk.data, 'base64')); offset = chunk.nextOffset;
  }
  const bytes = Buffer.concat(buffers); assert.equal(bytes.length, payload.totalBytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), payload.sha256);
  assert.deepEqual(JSON.parse(bytes.toString()).event, f.events[1]);
  assert.equal((await f.call('content.release', { contentId: payload.contentId })).released, true);
  assert.equal((await f.rpc('content.read', { contentId: payload.contentId })).error.code, 'CONTENT_EXPIRED');
});

test('prompt business ID is independent of transport ID, deduplicates and checks conflicts', async t => {
  const f = await setup(t);
  const p = { sessionId: 'session-1', clientRequestId: 'phone-prompt-1', content: [{ type: 'text', text: '你好' }], clientTimeZone: 'America/New_York' };
  const [one, two] = await Promise.all([f.call('session.prompt', p), f.call('session.prompt', p)]);
  assert.deepEqual(one, { accepted: true, clientRequestId: 'phone-prompt-1' }); assert.deepEqual(two, one);
  assert.equal(f.state.prompts.length, 1); assert.equal(f.state.prompts[0].requestId, p.clientRequestId);
  assert.equal((await f.rpc('session.prompt', { ...p, content: [{ type: 'text', text: 'different' }] })).error.code, 'ID_CONFLICT');
  await f.call('session.cancel', { sessionId: 'session-1' }); assert.equal(f.state.cancelled.length, 1);
  await f.call('session.queue.update', { sessionId: 'session-1', itemId: 'queued', action: { kind: 'edit', content: [{ type: 'text', text: '改写' }] } });
  assert.equal(f.state.queued[0].action.content[0].text, '改写');
});

test('subscribe opening precedes live events; replay cut and disconnect cleanup', async t => {
  const f = await setup(t), frames = [];
  f.launcher.wss.on('frame', ({ message }) => frames.push(message));
  const subscribed = await f.call('session.subscribe', { subscriptionId: 'subscription-1', sessionId: 'session-1', afterSeq: 0 });
  assert.equal(subscribed.opening.value.type, 'snapshot'); assert.deepEqual(subscribed.replay, { afterSeq: 0, throughSeq: 2 });
  const frame = { type: 'assistant-stream', frame: { type: 'chunk', index: 0, revision: 1, attemptId: 'attempt', chunk: { type: 'text', text: '实时😀' } } };
  const event = wait(f.launcher.wss, 'frame', f => f.message.event === 'session.follow'); f.updates.emit('frame', frame);
  assert.deepEqual((await event).message.data.frame.value, frame);
  assert.ok(frames.findIndex(f => f.type === 'response') < frames.findIndex(f => f.event === 'session.follow'));
  await f.call('session.unsubscribe', { subscriptionId: 'subscription-1' }); await sleep(10);
  assert.equal(f.state.closed, 1); assert.equal(f.bridge.subscriptions.size, 0);
  await f.call('session.subscribe', { subscriptionId: 'subscription-2', sessionId: 'session-1' });
  f.events[1].data.large = 'x'.repeat(150000);
  await f.call('session.event', { sessionId: 'session-1', seq: 1 });
  const ready = wait(f.link, 'ready'); f.launcher.instances.get('chat-test').socket.terminate(); await ready;
  assert.equal(f.bridge.subscriptions.size, 0); assert.equal(f.bridge.content.bytes, 0);
  assert.equal(f.state.closed, 2);
});

test('creation, rename, fork, model and attachment operations preserve native values', async t => {
  const f = await setup(t);
  assert.equal((await f.call('session.create', { sessionId: 'named', cwd: 'C:/project' })).sessionId, 'named');
  assert.equal((await f.call('session.rename', { sessionId: 'named', title: '标题' })).title, '标题');
  assert.equal((await f.call('session.fork', { sessionId: 'named', atSeq: 1 })).sessionId, 'forked');
  await f.call('session.selectModel', { sessionId: 'named', provider: 'test', model: 'fake', reasoningEffort: 'high' });
  assert.equal(f.state.model.reasoningEffort, 'high');
  assert.equal((await f.call('model.catalog')).value.groups[0].id, 'test');
  assert.equal((await f.call('session.attachment', { sessionId: 'named', attachmentId: 'img-1' })).value.attachment.id, 'img-1');
  assert.equal((await f.call('session.projections', { sessionId: 'named' })).value.asOfSeq, 2);
});

test('invalid input, nonexistent sessions and subagent ownership are rejected', async t => {
  const f = await setup(t);
  const requests = [ ['session.list', { limit: 101 }], ['session.page', { sessionId: 'session-1', maxMessages: 0 }],
    ['session.create', { cwd: 'C:/a', workspaceId: 'w' }], ['session.get', { sessionId: '../outside' }],
    ['session.event', { sessionId: 'session-1' }], ['session.prompt', { sessionId: 'session-1', clientRequestId: 'id', content: [{ type: 'text', text: ' ' }] }],
    ['session.prompt', { sessionId: 'session-1', clientRequestId: 'id', content: [{ type: 'unknown' }] }],
    ['session.cancel', { sessionId: 'session-1', extra: true }], ['session.queue.update', { sessionId: 'session-1', itemId: 'q', action: { kind: 'invalid' } }],
  ];
  for (const [method, params] of requests) assert.equal((await f.rpc(method, params)).error.code, 'INVALID_PARAMS', method);
  assert.equal((await f.rpc('session.get', { sessionId: 'missing' })).error.code, 'session/not-found');
  f.sessions.set('child', { id: 'child', origin: 'subagent' });
  assert.equal((await f.rpc('session.get', { sessionId: 'child' })).error.code, 'SUBAGENT_ADDRESS_REQUIRED');
  const wrong = { kind: 'subagent', childSessionId: 'child', parentSessionId: 'wrong', mode: 'unknown' };
  assert.equal((await f.rpc('session.get', { address: wrong })).error.code, 'subagent/unauthorized');
  assert.equal((await f.rpc('session.subscribe', { subscriptionId: 'ahead', sessionId: 'session-1', afterSeq: 100 })).error.code, 'CURSOR_AHEAD');
  assert.equal(f.bridge.subscriptions.size, 0);
});

test('content expiry/capacity are bounded and never silently truncate', () => {
  let now = 0; const store = new ContentStore({ inlineBytes: 8, maxBytes: 100, ttlMs: 10, now: () => now });
  const a = store.pack('x'.repeat(60)), b = store.pack('y'.repeat(60));
  assert.throws(() => store.read(a.contentId), e => e.code === 'CONTENT_EXPIRED');
  assert.ok(store.bytes <= 100); now = 11;
  assert.throws(() => store.read(b.contentId), e => e.code === 'CONTENT_EXPIRED');
  assert.equal(store.bytes, 0);
  assert.throws(() => store.pack('z'.repeat(101)), e => e.code === 'CONTENT_TOO_LARGE');
});
