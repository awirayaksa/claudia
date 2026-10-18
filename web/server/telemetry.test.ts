/**
 * OpenTelemetry: a reply makes a request span, a run span, a model-call span
 * with token counts (and no text), a tool span, and an outgoing fetch span
 * whose trace context reaches the provider. A caller's traceparent is kept.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanKind } from '@opentelemetry/api';
import { startTelemetry, stopTelemetry } from './telemetry';
import { chatFixture, type ChatFixture } from './test/chat-fixture';
import type { RunToolset } from './llm/tools';

const exporter = new InMemorySpanExporter();
let f: ChatFixture;
const toolset: RunToolset = {
  definitions: [{ type: 'function', function: { name: 'echo', description: 'Echo', parameters: { type: 'object', properties: {} } } }],
  firstTurnOnly: false,
  locate: (alias) => (alias === 'echo' ? { serverId: 'srv-1', tool: 'echo' } : null),
  execute: async (call) => ({ serverId: 'srv-1', tool: 'echo', result: { type: 'tool_result', callId: call.id, content: 'done' } }),
};

beforeAll(async () => {
  expect(await startTelemetry({ exporter })).toBe(true);
  f = await chatFixture({ orchestrator: { toolsFor: async () => toolset } });
});
afterAll(async () => {
  await f?.close();
  await stopTelemetry();
});

const named = (spans: ReadableSpan[], name: string) => spans.filter((s) => s.name === name);

describe('tracing', () => {
  it('traces a reply from the request to the model call and its tool', async () => {
    exporter.reset();
    f.mock.push(
      { toolCalls: [{ id: 'call_1', name: 'echo', arguments: '{"text":"secret words"}' }] },
      { text: ['Private ', 'reply'], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } }
    );
    const chatId = await f.newChat(f.admin);
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const res = await f.admin.request({
      method: 'POST',
      url: `/api/chats/${chatId}/completions`,
      payload: { parentId: null, content: 'Very private question', modelIds: ['mock/gpt-test'] },
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect(res.statusCode).toBe(202);
    await f.readRun(f.admin, res.json().runId);

    let spans: ReadableSpan[] = [];
    await vi.waitFor(() => {
      spans = exporter.getFinishedSpans();
      expect(named(spans, 'claudia.run')).toHaveLength(1);
    });
    const request = named(spans, 'POST /api/chats/:id/completions')[0];
    expect(request.kind).toBe(SpanKind.SERVER);
    expect(request.attributes).toMatchObject({ 'http.route': '/api/chats/:id/completions', 'http.response.status_code': 202 });
    // The caller's trace continues
    expect(request.spanContext().traceId).toBe(traceId);

    const run = named(spans, 'claudia.run')[0];
    expect(run.spanContext().traceId).toBe(traceId);
    const model = named(spans, 'chat gpt-test')[0];
    expect(model.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    expect(model.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': 'gpt-test',
      'gen_ai.usage.input_tokens': 11,
      'gen_ai.usage.output_tokens': 4,
      'claudia.status': 'completed',
    });
    const tool = named(spans, 'execute_tool echo')[0];
    expect(tool.attributes).toMatchObject({ 'gen_ai.tool.name': 'echo', 'gen_ai.tool.call.id': 'call_1' });
    expect(tool.parentSpanContext?.spanId).toBe(model.spanContext().spanId);

    // Calls to the provider are client spans in the same trace, and carry the context
    const outgoing = spans.filter((s) => s.kind === SpanKind.CLIENT && s.spanContext().traceId === traceId);
    expect(outgoing.length).toBeGreaterThanOrEqual(2);
    const sentTraceparents = f.mock.headers.map((h) => h.traceparent).filter(Boolean) as string[];
    expect(sentTraceparents.some((tp) => tp.startsWith(`00-${traceId}-`))).toBe(true);

    // Nothing users wrote or read is in any span
    const everything = JSON.stringify(spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })));
    for (const text of ['Very private question', 'Private reply', 'secret words']) expect(everything).not.toContain(text);
  });

  it('marks failed model calls', async () => {
    exporter.reset();
    f.mock.push({ fail: { status: 500, message: 'provider down' } });
    const chatId = await f.newChat(f.admin);
    const res = await f.admin.post(`/api/chats/${chatId}/completions`, { parentId: null, content: 'x', modelIds: ['mock/gpt-test'] });
    await f.readRun(f.admin, res.json().runId);
    await vi.waitFor(() => expect(named(exporter.getFinishedSpans(), 'chat gpt-test')).toHaveLength(1));
    const model = named(exporter.getFinishedSpans(), 'chat gpt-test')[0];
    expect(model.attributes['claudia.status']).toBe('error');
    expect(model.status.code).toBe(2);
  });
});
