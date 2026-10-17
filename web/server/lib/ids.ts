import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then randomness. Ids sort by
 * creation time, which keeps B-tree indexes compact. Within one millisecond a
 * 12-bit counter keeps them increasing.
 */
export function uuidv7(now = Date.now()): string {
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) now = ++lastMs; // counter wrapped: borrow the next millisecond
  } else {
    lastMs = Math.max(now, lastMs);
    now = lastMs;
    seq = randomBytes(2).readUInt16BE(0) & 0x3ff; // random start, room to count up
  }

  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = 0x70 | (seq >> 8); // version 7 + counter high bits
  b[7] = seq & 0xff;
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
