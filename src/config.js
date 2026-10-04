export const VERSION = '0.2.8';
export const PROTOCOL = 'dsh.launcher.v1';

export function resolveConfig(input = {}, env = process.env) {
  const url = input.url ?? env.DSH_LAUNCHER_URL ?? '';
  const config = {
    url,
    token: input.token ?? env.DSH_LAUNCHER_TOKEN ?? '',
    instanceId: input.instanceId ?? env.DSH_INSTANCE_ID ?? '',
    label: input.label ?? env.DSH_INSTANCE_LABEL ?? '',
    profile: input.profile ?? env.DSH_INSTANCE_PROFILE ?? '',
    heartbeatMs: input.heartbeatMs ?? 10_000,
    heartbeatTimeoutMs: input.heartbeatTimeoutMs ?? 30_000,
    handshakeTimeoutMs: input.handshakeTimeoutMs ?? 10_000,
    requestTimeoutMs: input.requestTimeoutMs ?? 30_000,
    reconnectMinMs: input.reconnectMinMs ?? 500,
    reconnectMaxMs: input.reconnectMaxMs ?? 30_000,
    maxPayloadBytes: input.maxPayloadBytes ?? 262_144,
    maxBufferedBytes: input.maxBufferedBytes ?? 1_048_576,
    maxConcurrentRequests: input.maxConcurrentRequests ?? 16,
    requestCacheSize: input.requestCacheSize ?? 256,
  };
  for (const key of Object.keys(config).filter(key => /Ms$|Bytes$|Requests$|Size$/.test(key))) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`);
  }
  if (config.reconnectMaxMs < config.reconnectMinMs) throw new Error('Invalid reconnect interval');
  if (config.heartbeatTimeoutMs <= config.heartbeatMs) throw new Error('Heartbeat timeout must exceed its interval');
  if (!url) return config;
  const parsed = new URL(url);
  if (!['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || parsed.search) {
    throw new Error('Launcher URL must be ws/wss without credentials, query or fragment');
  }
  if (parsed.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    throw new Error('Use wss for a launcher outside loopback');
  }
  if (typeof config.token !== 'string' || config.token.length < 16 || /[\r\n]/.test(config.token)) throw new Error('Set DSH_LAUNCHER_TOKEN (at least 16 characters)');
  if (typeof config.instanceId !== 'string' || !/^[\w.:-]{1,128}$/.test(config.instanceId)) throw new Error('Set a stable DSH_INSTANCE_ID');
  for (const key of ['label', 'profile']) if (typeof config[key] !== 'string' || config[key].length > 256) throw new Error(`Invalid ${key}`);
  return config;
}
