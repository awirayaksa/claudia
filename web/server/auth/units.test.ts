import { describe, it, expect } from 'vitest';
import { createKeyring } from '../crypto/keys';
import { SecretBox, maskSecret } from '../crypto/secrets';
import { uuidv7, isUuid } from '../lib/ids';
import { MemoryLoginGuard } from './login-guard';
import { signAccessToken, verifyAccessToken, parseRefreshToken, ACCESS_TTL_SECONDS } from './tokens';
import { RunHub } from '../llm/run-hub';
import { cleanTitle, fallbackTitle } from '../llm/tasks';
import { PartsBuilder } from '../llm/parts-builder';

const ROOT = 'root-secret-root-secret-root-secret-xx';

describe('access tokens', () => {
  const key = createKeyring(ROOT).jwt;

  it('round-trips and reports expiry separately from tampering', async () => {
    const token = await signAccessToken(key, { userId: 'u1', sessionId: 's1' });
    expect(await verifyAccessToken(key, token)).toEqual({ ok: true, claims: { userId: 'u1', sessionId: 's1' } });

    const old = await signAccessToken(key, { userId: 'u1', sessionId: 's1' }, Date.now() - (ACCESS_TTL_SECONDS + 5) * 1000);
    expect(await verifyAccessToken(key, old)).toEqual({ ok: false, reason: 'expired' });

    const otherKey = createKeyring('another-root-secret-another-root-secret').jwt;
    expect(await verifyAccessToken(otherKey, token)).toEqual({ ok: false, reason: 'invalid' });
    expect(await verifyAccessToken(key, token.slice(0, -2) + 'xx')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('parses refresh tokens', () => {
    expect(parseRefreshToken('sid.secret.with.dots')).toEqual({ sessionId: 'sid', secret: 'secret.with.dots' });
    expect(parseRefreshToken('nodot')).toBeNull();
    expect(parseRefreshToken(undefined)).toBeNull();
  });
});

describe('secrets', () => {
  it('encrypts with a fresh IV and decrypts', () => {
    const box = new SecretBox(createKeyring(ROOT));
    const a = box.encrypt('sk-123');
    const b = box.encrypt('sk-123');
    expect(a).not.toBe(b);
    expect(a.startsWith(`v1:${box.currentKeyId}:`)).toBe(true);
    expect(box.decrypt(a)).toBe('sk-123');
  });

  it('detects tampering', () => {
    const box = new SecretBox(createKeyring(ROOT));
    const parts = box.encrypt('sk-123').split(':');
    parts[4] = Buffer.from('evil').toString('base64url');
    expect(() => box.decrypt(parts.join(':'))).toThrow();
  });

  it('decrypts values from a previous root secret during rotation', () => {
    const oldBox = new SecretBox(createKeyring('old-root-secret-old-root-secret-xxxx'));
    const stored = oldBox.encrypt('sk-old');
    const rotating = new SecretBox(createKeyring(ROOT, ['old-root-secret-old-root-secret-xxxx']));
    expect(rotating.decrypt(stored)).toBe('sk-old');
    expect(rotating.keyIdOf(stored)).not.toBe(rotating.currentKeyId);
    expect(() => new SecretBox(createKeyring(ROOT)).decrypt(stored)).toThrow(/No key/);
  });

  it('masks keys', () => {
    expect(maskSecret('sk-abcdef1234')).toEqual({ hasKey: true, last4: '1234' });
    expect(maskSecret('short')).toEqual({ hasKey: true, last4: undefined });
    expect(maskSecret(null)).toEqual({ hasKey: false });
  });
});

describe('uuidv7', () => {
  it('is a valid v7 uuid that sorts by creation', () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7());
    expect(ids.every(isUuid)).toBe(true);
    expect(ids[0][14]).toBe('7');
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
  });
});

describe('LoginGuard', () => {
  it('allows five failures, then locks with doubling waits', async () => {
    let now = 0;
    const g = new MemoryLoginGuard(() => now);
    for (let i = 0; i < 5; i++) await g.recordFailure('a');
    expect(await g.lockedFor('a')).toBe(0);
    await g.recordFailure('a');
    expect(await g.lockedFor('a')).toBe(30_000);
    now += 30_000;
    await g.recordFailure('a');
    expect(await g.lockedFor('a')).toBe(60_000);
    await g.recordSuccess('a');
    expect(await g.lockedFor('a')).toBe(0);
  });
});

describe('RunHub', () => {
  it('locks a branch point, caps concurrent runs and replays events', async () => {
    const hub = new RunHub();
    const run = await hub.start({ userId: 'u', chatId: 'c', lockKey: 'c:root', maxConcurrent: 2 });
    await expect(hub.start({ userId: 'u', chatId: 'c', lockKey: 'c:root', maxConcurrent: 2 })).rejects.toThrow(/already being written/);
    await hub.start({ userId: 'u', chatId: 'c', lockKey: 'c:x', maxConcurrent: 2 });
    await expect(hub.start({ userId: 'u', chatId: 'd', lockKey: 'd:root', maxConcurrent: 2 })).rejects.toThrow(/already have 2/);

    hub.emit(run, { type: 'message.delta', messageId: 'm', text: 'a' });
    hub.emit(run, { type: 'message.delta', messageId: 'm', text: 'b' });
    const seen: number[] = [];
    const unsub = await hub.subscribe(run, 1, (e) => seen.push(e.seq));
    hub.emit(run, { type: 'message.delta', messageId: 'm', text: 'c' });
    unsub();
    hub.finish(run, 'completed');
    expect(seen).toEqual([2, 3]);
    // Lock released
    await expect(hub.start({ userId: 'v', chatId: 'c', lockKey: 'c:root', maxConcurrent: 2 })).resolves.toBeTruthy();
    hub.close();
  });

  it('times out a browser tool and resolves a submitted one', async () => {
    const hub = new RunHub();
    const run = await hub.start({ userId: 'u', chatId: 'c', lockKey: 'k', maxConcurrent: 1 });
    const timedOut = await hub.awaitClientTool(run, 'call-1', 10);
    expect(timedOut.isError).toBe(true);
    const pending = hub.awaitClientTool(run, 'call-2', 5_000);
    expect(await hub.submitClientTool(run, 'call-2', { content: 'done' })).toBe(true);
    expect(await pending).toEqual({ content: 'done' });
    expect(await hub.submitClientTool(run, 'call-2', { content: 'again' })).toBe(false);
    hub.close();
  });
});

describe('titles and parts', () => {
  it('cleans model titles and falls back to the first line', () => {
    expect(cleanTitle('"Trip to Oslo."')).toBe('Trip to Oslo');
    expect(cleanTitle('Title: **Budget Review**\nmore')).toBe('Budget Review');
    expect(fallbackTitle('A question\nwith details')).toBe('A question');
    expect(fallbackTitle('x'.repeat(80))).toHaveLength(51);
  });

  it('merges deltas into parts in order', () => {
    const b = new PartsBuilder();
    b.appendReasoning('a');
    b.appendReasoning('b');
    b.appendText('c');
    b.add({ type: 'tool_call', callId: '1', alias: 't', serverId: 's', tool: 't', args: '{}' });
    b.appendText('d');
    b.appendText('');
    expect(b.parts).toEqual([
      { type: 'reasoning', text: 'ab' },
      { type: 'text', text: 'c' },
      { type: 'tool_call', callId: '1', alias: 't', serverId: 's', tool: 't', args: '{}' },
      { type: 'text', text: 'd' },
    ]);
    expect(b.text()).toBe('cd');
  });
});
