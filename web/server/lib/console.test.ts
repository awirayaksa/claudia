import { describe, it, expect, afterEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { routeConsoleToLogger } from './console';

const original = { ...console };
afterEach(() => Object.assign(console, original));

function fakeLogger(debugEnabled: boolean) {
  return {
    level: debugEnabled ? 'debug' : 'info',
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('routeConsoleToLogger', () => {
  it('drops chatty output unless debugging, and caps lines', () => {
    const log = fakeLogger(false);
    routeConsoleToLogger(log as unknown as FastifyBaseLogger);
    console.log('[Provider] Request body:', JSON.stringify({ messages: [{ content: 'private' }] }));
    expect(log.debug).not.toHaveBeenCalled();

    console.warn('x'.repeat(5000));
    const [, msg] = log.warn.mock.calls[0];
    expect(msg.length).toBeLessThan(2100);
    expect(msg).toMatch(/more characters\)$/);
    console.error('boom', 42);
    expect(log.error).toHaveBeenCalledWith({ source: 'console' }, 'boom 42');
  });

  it('passes chatty output to debug when enabled', () => {
    const log = fakeLogger(true);
    routeConsoleToLogger(log as unknown as FastifyBaseLogger);
    console.info('hello %s', 'there');
    expect(log.debug).toHaveBeenCalledWith({ source: 'console' }, 'hello there');
  });
});
