import http from 'node:http';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

const protocol = 'dsh.launcher.v1';
const hash = value => createHash('sha256').update(value).digest();

/** Local integration example, not a mobile gateway or a DSH process launcher. */
export async function createMockLauncher({ token, port = 0, heartbeat = true, autoPing = false } = {}) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('Set a token of at least 16 characters');
  const instances = new Map();
  const connections = new Set();
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 262144, perMessageDeflate: false,
    handleProtocols: protocols => protocols.has(protocol) ? protocol : false });
  server.on('upgrade', (request, socket, head) => {
    const authorization = request.headers.authorization ?? '';
    const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
    if (request.url !== '/dsh-link/v1' || !offered.includes(protocol) || !timingSafeEqual(hash(authorization), hash(`Bearer ${token}`))) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    connections.add(ws);
    const handshake = setTimeout(() => ws.terminate(), 10000);
    handshake.unref();
    let instanceId;
    const send = frame => ws.send(JSON.stringify({ v: 1, ...frame }));
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      let message;
      try { if (binary) throw new Error(); message = JSON.parse(data.toString()); } catch { ws.close(1007); return; }
      if (!message || message.v !== 1) { ws.close(1002); return; }
      if (!instanceId) {
        const id = message.instance?.instanceId;
        if (message.type !== 'hello' || typeof message.connectionId !== 'string' || !/^[\w.:-]{1,128}$/.test(id ?? '')) { ws.close(4003); return; }
        if (instances.has(id)) { ws.close(4009, 'Duplicate instance ID'); return; }
        instanceId = id;
        clearTimeout(handshake);
        instances.set(id, { socket: ws, info: message.instance, connectionId: message.connectionId });
        send({ type: 'welcome', instanceId: id, connectionId: message.connectionId });
        wss.emit('registered', instances.get(id));
        if (autoPing) send({ type: 'request', id: randomUUID(), method: 'system.ping', params: null });
        return;
      }
      if (message.type === 'ping' && heartbeat) send({ type: 'pong', id: message.id });
      wss.emit('frame', { instanceId, message, socket: ws });
    });
    ws.on('close', () => {
      clearTimeout(handshake);
      connections.delete(ws);
      if (instances.get(instanceId)?.socket === ws) instances.delete(instanceId);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {
    url: `ws://127.0.0.1:${server.address().port}/dsh-link/v1`, instances, wss,
    send(instanceId, frame) {
      const entry = instances.get(instanceId);
      if (!entry) throw new Error('Instance offline');
      entry.socket.send(JSON.stringify({ v: 1, ...frame }));
    },
    async close() {
      for (const ws of connections) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const launcher = await createMockLauncher({ token: process.env.DSH_LAUNCHER_TOKEN, port: Number(process.env.DSH_LAUNCHER_PORT ?? 3090), autoPing: true });
  console.log(`Launcher link listening: ${launcher.url}`);
  launcher.wss.on('registered', entry => console.log(`Registered: ${entry.info.instanceId} (${entry.info.label})`));
  launcher.wss.on('frame', ({ instanceId, message }) => {
    if (message.type === 'response') console.log(`Response: ${instanceId} ${message.id} ${message.ok ? 'ok' : message.error?.code}`);
  });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await launcher.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
