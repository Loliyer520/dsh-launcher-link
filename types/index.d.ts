import { EventEmitter } from 'node:events';

export type LinkState = 'disabled' | 'stopped' | 'connecting' | 'handshaking' | 'ready' | 'reconnecting' | 'rejected';
/** Original DSH JSON, preserved without flattening content blocks. */
export type Payload<T = unknown> = { kind: 'inline'; value: T } | ContentReference;
export interface ContentReference {
  kind: 'content-ref'; contentId: string; encoding: 'utf8-json'; totalBytes: number;
  sha256: string; chunkBytes: number; expiresAt: number;
}
export interface ContentChunk {
  contentId: string; offset: number; nextOffset: number; totalBytes: number;
  encoding: 'base64'; data: string; done: boolean; sha256: string;
}
export type ChatAddress = { kind: 'session'; sessionId: string } |
  { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' | 'unknown' };
export type PromptContentPart = { type: 'text'; text: string } |
  { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string; name?: string } |
  { type: 'file'; receiptId: string };
export interface PromptParams {
  sessionId: string; clientRequestId: string; content: PromptContentPart[];
  mode?: 'queue' | 'steer'; clientTimeZone?: string;
}
export interface SubscriptionResult<T = unknown> {
  subscriptionId: string; opening: Payload<T>; replay: { afterSeq: number; throughSeq: number } | null;
}
export interface LinkConfig {
  /** Enable the native sessionController adapter when the host provides it. Default true. */
  chat?: boolean;
  url?: string;
  token?: string;
  instanceId?: string;
  label?: string;
  profile?: string;
  heartbeatMs?: number;
  heartbeatTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  requestTimeoutMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  maxPayloadBytes?: number;
  maxBufferedBytes?: number;
  maxConcurrentRequests?: number;
  requestCacheSize?: number;
}
export interface InstanceInfo {
  instanceId: string;
  label: string;
  profile: string;
  pid: number;
  pluginVersion: string;
  protocol: 'dsh.launcher.v1';
  methods: string[];
  state: LinkState;
}
export interface RequestContext {
  signal: AbortSignal;
  requestId: string;
  instanceId: string;
  publish(event: string, data?: unknown): boolean;
}
export class LinkError extends Error {
  constructor(code: string, message: string);
  code: string;
}
export class LauncherLink extends EventEmitter {
  constructor(config?: LinkConfig);
  readonly state: LinkState;
  info(): InstanceInfo;
  start(): void;
  stop(): void;
  registerMethod(name: string, handler: (params: unknown, request: RequestContext) => unknown | Promise<unknown>): () => void;
  publish(event: string, data?: unknown): boolean;
}
export const name: 'launcher-link';
export const inject: [];
export const provide: ['launcherLink'];
export function apply(ctx: import('@deepseek-ai/cordis').Context, config?: LinkConfig): void;

declare module '@deepseek-ai/cordis' {
  interface Context { launcherLink: LauncherLink; }
}
