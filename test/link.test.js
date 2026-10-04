import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { LauncherLink, LinkError } from '../src/transport.js';
import { createMockLauncher } from '../examples/mock-launcher.mjs';

const token = 'test-only-token-not-a-production-key';
const limit = 3000;

function event(emitter, name, filter = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { emitter.off(name, listener); reject(new Error(`Timed out waiting for ${name}`)); }, limit);
    const listener = value => { if (!filter(value)) return; clearTimeout(timeout); emitter.off(name, listener); resolve(value); };
    emitter.on(name, listener);
  });
}

async function setup(t, overrides = {}, serverOptions = {}) {
  const launcher = await createMockLauncher({ token, ...serverOptions });
  const link = new LauncherLink({ url: launcher.url, token, instanceId: 'dsh-test-1',
    heartbeatMs: 50, heartbeatTimeoutMs: 200, reconnectMinMs: 20, reconnectMaxMs: 100,
    handshakeTimeoutMs: 300, requestTimeoutMs: 500, ...overrides }, { env: {}, random: () => .5 });
  t.after(async () => { link.stop(); await launcher.close(); });
  const ready = event(link, 'ready');
  link.start();
  await ready;
  return { launcher, link };
}

async function call(launcher, instanceId, id, method, params) {
  const response = event(launcher.wss, 'frame', frame => frame.instanceId === instanceId && frame.message.type === 'response' && frame.message.id === id);
  launcher.send(instanceId, { type: 'request', id, method, params });
  return (await response).message;
}

test('multiple instances register independently and route by stable ID', async t => {
  const { launcher, link } = await setup(t);
  const second = new LauncherLink({ ...link.config, instanceId: 'dsh-test-2', label: 'second' }, { env: {} });
  t.after(() => second.stop());
  const ready = event(second, 'ready');
  second.start(); await ready;
  assert.equal(launcher.instances.size, 2);
  assert.notEqual(launcher.instances.get('dsh-test-1').connectionId, launcher.instances.get('dsh-test-2').connectionId);
  const firstInfo = await call(launcher, 'dsh-test-1', 'info-1', 'instance.info', null);
  const secondInfo = await call(launcher, 'dsh-test-2', 'info-2', 'instance.info', null);
  assert.equal(firstInfo.result.instanceId, 'dsh-test-1');
  assert.equal(secondInfo.result.label, 'second');
  assert.equal(secondInfo.result.state, 'ready');
  assert.ok(!JSON.stringify(firstInfo).includes(token));
});

test('authentication failure and duplicate instance ID stop retrying', async t => {
  const { launcher, link } = await setup(t);
  for (const config of [{ token: `${token}-wrong`, instanceId: 'wrong-auth' }, { instanceId: link.config.instanceId }]) {
    const rejected = new LauncherLink({ ...link.config, ...config }, { env: {} });
    t.after(() => rejected.stop());
    const state = event(rejected, 'state', status => status.state === 'rejected');
    rejected.start(); await state;
    await sleep(100);
    assert.equal(rejected.running, false);
    assert.equal(rejected.state, 'rejected');
  }
  assert.equal(launcher.instances.size, 1);
  assert.equal(link.state, 'ready');
});

test('missing subprotocol and mismatched welcome are terminal registration failures', async t => {
  for (const invalid of ['subprotocol', 'welcome']) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1',
      handleProtocols: protocols => invalid === 'subprotocol' ? false : [...protocols][0] });
    await once(server, 'listening');
    server.on('connection', peer => {
      peer.on('error', () => {});
      peer.on('message', data => {
        const message = JSON.parse(data.toString());
        peer.send(JSON.stringify({ v: 1, type: 'welcome', instanceId: 'wrong-instance', connectionId: message.connectionId }));
      });
    });
    const link = new LauncherLink({ url: `ws://127.0.0.1:${server.address().port}`, token, instanceId: 'expected-instance' }, { env: {} });
    t.after(async () => { link.stop(); for (const peer of server.clients) peer.terminate(); await new Promise(resolve => server.close(resolve)); });
    const rejected = event(link, 'state', state => state.state === 'rejected');
    link.start(); await rejected;
    assert.equal(link.running, false);
  }
});

test('request execution, event forwarding, capability updates and safe errors', async t => {
  const { launcher, link } = await setup(t);
  const changed = event(launcher.wss, 'frame', frame => frame.message.event === 'capabilities.changed' && frame.message.data.methods.includes('example.echo'));
  const dispose = link.registerMethod('example.echo', (params, request) => {
    request.publish('example.progress', { requestId: request.requestId, instanceId: request.instanceId });
    return params;
  });
  assert.ok((await changed).message.data.methods.includes('example.echo'));
  const progress = event(launcher.wss, 'frame', frame => frame.message.event === 'example.progress');
  const response = await call(launcher, link.config.instanceId, 'echo', 'example.echo', { greeting: '你好' });
  assert.deepEqual(response.result, { greeting: '你好' });
  const message = (await progress).message;
  assert.equal(message.instanceId, link.config.instanceId);
  assert.equal(message.connectionId, link.connectionId);
  assert.equal(message.data.requestId, 'echo');
  dispose();
  assert.equal((await call(launcher, link.config.instanceId, 'unknown', 'example.echo', null)).error.code, 'METHOD_NOT_FOUND');
  link.registerMethod('example.fail', () => { throw new Error('private-data-do-not-send'); });
  const failed = await call(launcher, link.config.instanceId, 'failed', 'example.fail', null);
  assert.equal(failed.error.code, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(failed).includes('private-data'));
  link.registerMethod('example.business', () => { throw new LinkError('NOT_READY', 'Please wait'); });
  assert.equal((await call(launcher, link.config.instanceId, 'business', 'example.business', null)).error.code, 'NOT_READY');
});

test('duplicates execute once while pending and return cached completion', async t => {
  const { launcher, link } = await setup(t);
  let executions = 0;
  link.registerMethod('example.once', async params => { executions++; await sleep(40); return params; });
  const request = { type: 'request', id: 'same-id', method: 'example.once', params: { n: 1 } };
  const result = event(launcher.wss, 'frame', frame => frame.message.type === 'response' && frame.message.id === 'same-id');
  launcher.send(link.config.instanceId, request);
  launcher.send(link.config.instanceId, request);
  assert.equal((await result).message.ok, true);
  const cached = await call(launcher, link.config.instanceId, 'same-id', 'example.once', { n: 1 });
  assert.deepEqual(cached.result, { n: 1 });
  assert.equal(executions, 1);
  assert.equal((await call(launcher, link.config.instanceId, 'same-id', 'example.once', { n: 2 })).error.code, 'ID_CONFLICT');
  assert.equal(executions, 1);
});

test('timeout, cancellation and concurrency limit signal handlers', async t => {
  const { launcher, link } = await setup(t, { requestTimeoutMs: 80, maxConcurrentRequests: 1 });
  const aborted = [];
  let entered;
  link.registerMethod('example.wait', (_params, request) => {
    request.signal.addEventListener('abort', () => aborted.push(request.signal.reason.code), { once: true });
    entered?.();
    return new Promise(() => {});
  });
  const timeout = event(launcher.wss, 'frame', frame => frame.message.id === 'timeout' && frame.message.type === 'response');
  launcher.send(link.config.instanceId, { type: 'request', id: 'timeout', method: 'example.wait' });
  assert.equal((await call(launcher, link.config.instanceId, 'busy', 'example.wait', null)).error.code, 'BUSY');
  assert.equal((await timeout).message.error.code, 'TIMEOUT');
  const cancelled = event(launcher.wss, 'frame', frame => frame.message.id === 'cancelled' && frame.message.type === 'response');
  const started = new Promise(resolve => { entered = resolve; });
  launcher.send(link.config.instanceId, { type: 'request', id: 'cancelled', method: 'example.wait' });
  await started;
  launcher.send(link.config.instanceId, { type: 'cancel', id: 'cancelled' });
  assert.equal((await cancelled).message.error.code, 'CANCELLED');
  assert.deepEqual(aborted, ['TIMEOUT', 'CANCELLED']);
});

test('a request cancelled before its handler starts does not execute it', async t => {
  const { launcher, link } = await setup(t);
  let executions = 0;
  link.registerMethod('example.cancelEarly', () => { executions++; return {}; });
  const response = event(launcher.wss, 'frame', frame => frame.message.type === 'response' && frame.message.id === 'early');
  const task = link.handleRequest({ id: 'early', method: 'example.cancelEarly' }, link.socket);
  link.requests.get('early').controller.abort(new LinkError('CANCELLED', 'Request cancelled'));
  await task;
  assert.equal((await response).message.error.code, 'CANCELLED');
  assert.equal(executions, 0);
});

test('disconnect aborts requests and never replays them on the new connection', async t => {
  const { launcher, link } = await setup(t);
  let executions = 0;
  let context;
  const entered = new Promise(resolve => link.registerMethod('example.sideEffect', (_params, request) => {
    executions++; context = request; resolve(); return new Promise(() => {});
  }));
  launcher.send(link.config.instanceId, { type: 'request', id: 'in-flight', method: 'example.sideEffect' });
  await entered;
  const oldId = link.connectionId;
  const ready = event(link, 'ready');
  launcher.instances.get(link.config.instanceId).socket.terminate();
  await ready;
  assert.equal(context.signal.reason.code, 'DISCONNECTED');
  assert.equal(context.publish('example.stale', {}), false);
  assert.notEqual(link.connectionId, oldId);
  assert.equal(executions, 1);
  assert.equal(link.requests.size, 0);
  assert.equal(link.cache.size, 0);
});

test('heartbeat loss reconnects; stopping prevents subsequent reconnection', async t => {
  const { launcher, link } = await setup(t, { heartbeatMs: 20, heartbeatTimeoutMs: 60 }, { heartbeat: false });
  const oldId = link.connectionId;
  await event(link, 'ready');
  assert.notEqual(link.connectionId, oldId);
  const disconnect = once(launcher.instances.get(link.config.instanceId).socket, 'close');
  link.stop(); await disconnect;
  await sleep(150);
  assert.equal(launcher.instances.size, 0);
  assert.equal(link.state, 'stopped');
  assert.equal(link.publish('example.offline', {}), false);
});

test('oversized and non-JSON results return bounded errors', async t => {
  const { launcher, link } = await setup(t, { maxPayloadBytes: 2048 });
  link.registerMethod('example.large', () => 'x'.repeat(4096));
  link.registerMethod('example.bigint', () => 2n);
  assert.equal((await call(launcher, link.config.instanceId, 'large', 'example.large', null)).error.code, 'RESULT_TOO_LARGE');
  assert.equal((await call(launcher, link.config.instanceId, 'bigint', 'example.bigint', null)).error.code, 'INVALID_RESULT');
  assert.equal(link.state, 'ready');
});

test('binary and malformed frames close and recover without crashing', async t => {
  const { launcher, link } = await setup(t);
  for (const data of [Buffer.from('binary'), '{bad-json', JSON.stringify({ v: 99, type: 'ping' })]) {
    const peer = launcher.instances.get(link.config.instanceId).socket;
    const closed = once(peer, 'close');
    const ready = event(link, 'ready');
    peer.send(data);
    const [code] = await closed;
    assert.ok([1002, 1003, 1007].includes(code));
    await ready;
  }
});

test('disabled config is inert and unsafe connection configs are rejected', () => {
  const disabled = new LauncherLink({}, { env: {} });
  disabled.start(); assert.equal(disabled.state, 'disabled'); assert.equal(disabled.socket, null);
  const base = { token, instanceId: 'test' };
  for (const url of ['http://127.0.0.1:3090', 'ws://192.168.1.2:3090', 'ws://user:password@localhost:3090', 'ws://localhost:3090?token=secret']) {
    assert.throws(() => new LauncherLink({ ...base, url }, { env: {} }));
  }
  assert.throws(() => new LauncherLink({ ...base, url: 'ws://localhost:3090', token: 'short' }, { env: {} }));
  assert.throws(() => new LauncherLink({ ...base, url: 'ws://localhost:3090', instanceId: '../unsafe' }, { env: {} }));
  const configured = new LauncherLink({}, { env: { DSH_LAUNCHER_URL: 'ws://127.0.0.1:3090/dsh-link', DSH_LAUNCHER_TOKEN: token, DSH_INSTANCE_ID: 'env-id' } });
  assert.equal(configured.config.instanceId, 'env-id');
});
