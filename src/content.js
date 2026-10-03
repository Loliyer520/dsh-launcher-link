import { randomUUID, createHash } from 'node:crypto';
import { LinkError } from './transport.js';

export class ContentStore {
  constructor({ inlineBytes = 131072, chunkBytes = 49152, maxBytes = 67108864, ttlMs = 300000, now = Date.now } = {}) {
    Object.assign(this, { inlineBytes, chunkBytes, maxBytes, ttlMs, now });
    this.entries = new Map();
    this.bytes = 0;
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  release(id) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id); this.bytes -= entry.buffer.length; return true;
  }
  prune() { for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.release(id); }
  pack(value) {
    const buffer = Buffer.from(JSON.stringify(value ?? null));
    if (buffer.length <= this.inlineBytes) return { kind: 'inline', value: value ?? null };
    if (buffer.length > this.maxBytes) throw new LinkError('CONTENT_TOO_LARGE', 'Content exceeds cache capacity');
    this.prune();
    while (this.bytes + buffer.length > this.maxBytes || this.entries.size >= 256) this.release(this.entries.keys().next().value);
    const contentId = randomUUID();
    const entry = { buffer, sha256: createHash('sha256').update(buffer).digest('hex'), expiresAt: this.now() + this.ttlMs };
    this.entries.set(contentId, entry); this.bytes += buffer.length;
    return { kind: 'content-ref', contentId, encoding: 'utf8-json', totalBytes: buffer.length,
      sha256: entry.sha256, chunkBytes: this.chunkBytes, expiresAt: entry.expiresAt };
  }
  read(id, offset = 0, length = this.chunkBytes) {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new LinkError('CONTENT_EXPIRED', 'Content unavailable; repeat the source read');
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.buffer.length || !Number.isSafeInteger(length) || length < 1 || length > this.chunkBytes) {
      throw new LinkError('INVALID_PARAMS', 'Invalid content byte range');
    }
    const nextOffset = Math.min(offset + length, entry.buffer.length);
    return { contentId: id, offset, nextOffset, totalBytes: entry.buffer.length, encoding: 'base64',
      data: entry.buffer.subarray(offset, nextOffset).toString('base64'), done: nextOffset === entry.buffer.length, sha256: entry.sha256 };
  }
}
