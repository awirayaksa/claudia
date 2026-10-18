/**
 * OpenTelemetry tracing, on when OTEL_EXPORTER_OTLP_ENDPOINT is set (OTLP
 * over HTTP; the SDK reads the other OTEL_* variables: headers, sampler,
 * resource attributes). What is traced:
 * - every HTTP request to the app (a Fastify hook; incoming `traceparent`
 *   headers are honoured);
 * - outgoing fetch() calls — model providers, MCP over HTTP, webhooks,
 *   embeddings, web search — through undici's diagnostics channel, so load
 *   order doesn't matter;
 * - a span per reply run, per model call (GenAI semantic conventions: model,
 *   token counts; never prompt or reply text), per tool call and per job.
 * Without the variable the API is a no-op and nothing is loaded.
 */
import { context, propagation, SpanKind, SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { VERSION } from './version';

export const tracer = () => trace.getTracer('claudia-web', VERSION);

let shutdown: (() => Promise<void>) | null = null;

/** Start the SDK (once). `exporter` is a test hook (an in-memory exporter). */
export async function startTelemetry(
  opts: { endpoint?: string; serviceName?: string; exporter?: import('@opentelemetry/sdk-trace-base').SpanExporter } = {}
): Promise<boolean> {
  if (shutdown) return true;
  if (!opts.endpoint && !opts.exporter) return false;
  const [{ NodeTracerProvider }, { BatchSpanProcessor, SimpleSpanProcessor }, { resourceFromAttributes }, semconv, { registerInstrumentations }, { UndiciInstrumentation }] =
    await Promise.all([
      import('@opentelemetry/sdk-trace-node'),
      import('@opentelemetry/sdk-trace-base'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/semantic-conventions'),
      import('@opentelemetry/instrumentation'),
      import('@opentelemetry/instrumentation-undici'),
    ]);
  const exporter = opts.exporter ?? new (await import('@opentelemetry/exporter-trace-otlp-http')).OTLPTraceExporter();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || opts.serviceName || 'claudia-web',
      [semconv.ATTR_SERVICE_VERSION]: VERSION,
    }),
    spanProcessors: [opts.exporter ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)],
  });
  // W3C trace context in and out, and async context across awaits
  provider.register();
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [
      new UndiciInstrumentation({
        // The collector's own export requests aren't worth tracing
        ignoreRequestHook: (req) => !!opts.endpoint && `${req.origin}${req.path}`.startsWith(opts.endpoint),
      }),
    ],
  });
  shutdown = async () => {
    unregister();
    await provider.shutdown();
    shutdown = null;
    trace.disable();
    propagation.disable();
    context.disable();
  };
  return true;
}

export async function stopTelemetry(): Promise<void> {
  await shutdown?.();
}

/** Run `fn` inside a span; errors mark it failed and are rethrown. */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  kind: SpanKind = SpanKind.INTERNAL
): Promise<T> {
  return tracer().startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

const spans = new WeakMap<object, Span>();

/** A server span per request, named by route ("GET /api/chats/:id"), continuing the caller's trace. */
export function registerRequestTracing(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const parent = propagation.extract(context.active(), req.headers);
    const route = req.routeOptions.url;
    const span = tracer().startSpan(
      route ? `${req.method} ${route}` : req.method,
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': req.method,
          'url.path': req.url.split('?')[0],
          ...(route ? { 'http.route': route } : {}),
          'client.address': req.ip,
          'claudia.request_id': String(req.id),
        },
      },
      parent
    );
    spans.set(req, span);
    // Spans made while handling the request (runs, model calls) become its children
    context.with(trace.setSpan(parent, span), done);
  });
  app.addHook('onResponse', (req, reply, done) => {
    const span = spans.get(req);
    if (span) {
      span.setAttribute('http.response.status_code', reply.statusCode);
      if (req.user) span.setAttribute('enduser.id', req.user.id);
      if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      spans.delete(req);
    }
    done();
  });
}
