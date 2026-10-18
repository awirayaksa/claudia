import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** An error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, code = 'bad_request', details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue.', code = 'unauthorized') => new HttpError(401, code, message);
export const forbidden = (message = 'You do not have access to this.', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found.`);
export const conflict = (message: string, code = 'conflict') => new HttpError(409, code, message);
export const tooManyRequests = (message: string, code = 'rate_limited') => new HttpError(429, code, message);

/** Every error leaves the API as `{ error: { code, message } }`. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        },
      });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(status).send({ error: { code: 'internal', message: 'Something went wrong.' } });
    }
    // Fastify's own 4xx errors (bad JSON, body too large, rate limit)
    const code = status === 429 ? 'rate_limited' : ((err as FastifyError).code ?? 'bad_request').toLowerCase();
    return reply.code(status).send({ error: { code, message: err.message } });
  });
}
