/**
 * Code shared with the desktop app logs with console.* — sometimes whole
 * request bodies, i.e. users' messages. On the server that output goes
 * through the logger: log/info/debug only when LOG_LEVEL is debug or lower,
 * warn/error always, and every line is capped.
 */
import { format } from 'node:util';
import type { FastifyBaseLogger } from 'fastify';

const MAX_LINE = 2000;

const line = (args: unknown[]) => {
  const text = format(...args);
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}… (${text.length - MAX_LINE} more characters)` : text;
};

export function routeConsoleToLogger(log: FastifyBaseLogger): void {
  const chatty = (...args: unknown[]) => {
    if (log.level === 'debug' || log.level === 'trace') log.debug({ source: 'console' }, line(args));
  };
  console.log = chatty;
  console.info = chatty;
  console.debug = chatty;
  console.warn = (...args: unknown[]) => log.warn({ source: 'console' }, line(args));
  console.error = (...args: unknown[]) => log.error({ source: 'console' }, line(args));
}
