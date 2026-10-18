/**
 * /api/v1 — an OpenAI-compatible API over the models a user may use, with
 * API keys (Bearer ck-…). The OpenAI SDKs, and the desktop app as a custom
 * provider, can point their base URL at https://<host>/api/v1.
 *
 * Requests are passed to the provider as they are (tools included: the
 * caller runs them); custom models add their system prompt and defaults.
 * Usage counts against the user's caps like chats do.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ServerContext } from '../../context';
import { usageEvents } from '../../db/schema';
import { uuidv7 } from '../../lib/ids';
import { currentUser, requireUser } from '../../auth/rbac';
import type { ResolvedModel } from '../../llm/model-registry';
import { fillSystemVariables } from '../../../shared/prompts';
import type { ChatCompletionRequest, ChatMessage } from '../../../../src/types/api.types';
import type { ToolCall } from '../../../../src/types/message.types';
import type { MessageUsage } from '../../../../src/types/statistics.types';

const Message = z
  .object({
    role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
    content: z.union([z.string(), z.array(z.record(z.string(), z.unknown())), z.null()]).optional(),
    name: z.string().max(200).optional(),
    tool_calls: z.array(z.record(z.string(), z.unknown())).max(128).optional(),
    tool_call_id: z.string().max(200).optional(),
  })
  .loose();

const ChatRequest = z
  .object({
    model: z.string().min(1).max(500),
    messages: z.array(Message).min(1).max(2000),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).loose().nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    top_p: z.number().min(0).max(1).nullish(),
    max_tokens: z.number().int().min(1).nullish(),
    max_completion_tokens: z.number().int().min(1).nullish(),
    frequency_penalty: z.number().min(-2).max(2).nullish(),
    presence_penalty: z.number().min(-2).max(2).nullish(),
    tools: z.array(z.record(z.string(), z.unknown())).max(128).optional(),
    tool_choice: z.unknown().optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).nullish(),
  })
  .loose();
type ChatRequest = z.infer<typeof ChatRequest>;

/** OpenAI-style errors: the SDKs read `error.message`. */
function openaiError(reply: FastifyReply, status: number, message: string, code: string) {
  return reply.code(status).send({ error: { message, type: status === 429 ? 'rate_limit_error' : 'invalid_request_error', code } });
}

/** The provider request: the caller's, with a custom model's prompt and defaults underneath. */
function buildRequest(body: ChatRequest, target: ResolvedModel, userName: string): ChatCompletionRequest {
  const custom = target.custom;
  const defaults = custom?.params ?? {};
  const messages: ChatMessage[] = body.messages.map((m) => ({
    ...(m as unknown as ChatMessage),
    role: m.role === 'developer' ? 'system' : m.role,
  }));
  if (custom?.systemPrompt.trim()) {
    messages.unshift({ role: 'system', content: fillSystemVariables(custom.systemPrompt, { userName }) });
  }
  const pick = <T>(value: T | null | undefined, fallback: T | undefined) => value ?? fallback;
  const temperature = pick(body.temperature, defaults.temperature);
  const topP = pick(body.top_p, defaults.topP);
  const maxTokens = pick(body.max_completion_tokens ?? body.max_tokens, defaults.maxTokens);
  const frequency = pick(body.frequency_penalty, defaults.frequencyPenalty);
  const presence = pick(body.presence_penalty, defaults.presencePenalty);
  const effort = pick(body.reasoning_effort, defaults.effort);
  return {
    model: target.providerModelId,
    messages,
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { top_p: topP } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
    ...(frequency !== undefined ? { frequency_penalty: frequency } : {}),
    ...(presence !== undefined ? { presence_penalty: presence } : {}),
    ...(effort ? { reasoning_effort: effort } : {}),
    ...(body.tools?.length ? { tools: body.tools as unknown as ChatCompletionRequest['tools'] } : {}),
    ...(body.tool_choice !== undefined ? { tool_choice: body.tool_choice as ChatCompletionRequest['tool_choice'] } : {}),
  };
}

const usageOf = (u: MessageUsage | undefined) =>
  u
    ? {
        prompt_tokens: u.prompt_tokens ?? 0,
        completion_tokens: u.completion_tokens ?? 0,
        total_tokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
      }
    : undefined;

const toolCallsOut = (calls: ToolCall[]) =>
  calls.map((c, index) => ({ index, id: c.id, type: 'function' as const, function: { name: c.function.name, arguments: c.function.arguments } }));

export async function openaiRoutes(app: FastifyInstance, ctx: ServerContext): Promise<void> {
  app.addHook('preHandler', async (req, reply) => {
    if (!req.user) return openaiError(reply, 401, 'Missing or invalid API key. Send "Authorization: Bearer ck-…".', 'invalid_api_key');
    return requireUser(req, reply);
  });

  const modelEntry = (m: { id: string; name: string; connectionName: string; custom?: boolean }) => ({
    id: m.id,
    object: 'model' as const,
    created: 0,
    owned_by: m.custom ? 'claudia' : m.connectionName,
    name: m.name,
  });

  app.get('/models', async (req) => {
    const models = await ctx.models.forUser(currentUser(req));
    return { object: 'list', data: models.map(modelEntry) };
  });

  // Model ids contain slashes ("<prefix>/<model>")
  app.get('/models/*', async (req, reply) => {
    const id = (req.params as { '*': string })['*'];
    const model = (await ctx.models.forUser(currentUser(req))).find((m) => m.id === id);
    if (!model) return openaiError(reply, 404, `The model "${id}" does not exist or you do not have access to it.`, 'model_not_found');
    return modelEntry(model);
  });

  app.post(
    '/chat/completions',
    {
      bodyLimit: 16 * 1024 * 1024,
      config: {
        rateLimit: {
          max: async () => (await ctx.settings.get('limits')).completionsPerMinute,
          timeWindow: '1 minute',
          keyGenerator: (req: any) => `completions:${req.user?.id ?? req.ip}`,
        },
      },
    },
    async (req, reply) => {
      const me = currentUser(req);
      const parsed = ChatRequest.safeParse(req.body);
      if (!parsed.success) return openaiError(reply, 400, parsed.error.issues[0]?.message ?? 'Invalid request.', 'invalid_request');
      const body = parsed.data;
      await ctx.usage.check(me);
      const target = await ctx.models.resolve(body.model, me.role, me.id);
      const request = buildRequest(body, target, me.name);

      const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;
      const created = Math.floor(Date.now() / 1000);
      const started = Date.now();
      const controller = new AbortController();
      let usage: MessageUsage | undefined;
      const record = () => {
        if (!usage) return;
        void ctx.db
          .insert(usageEvents)
          .values({
            id: uuidv7(),
            userId: me.id,
            chatId: null,
            modelId: target.model.id,
            connectionId: target.connection.id,
            kind: 'api',
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            cost: usage.cost ?? null,
            latencyMs: Date.now() - started,
          })
          .catch((err) => ctx.log.warn({ err: String(err) }, 'recording API usage failed'));
      };

      if (!body.stream) {
        let content = '';
        let reasoning = '';
        let calls: ToolCall[] = [];
        // The caller went away before the answer: stop the provider request
        reply.raw.on('close', () => !reply.raw.writableFinished && controller.abort());
        const reason = await new Promise<string>((resolve, reject) => {
          void target.provider
            .streamChatCompletion(
              request,
              {
                onChunk: (t) => (content += t),
                onReasoning: (t) => (reasoning += t),
                onToolCalls: (c) => (calls = c),
                onUsage: (u) => (usage = u),
                onComplete: (r) => resolve(r ?? 'stop'),
                onError: reject,
              },
              controller.signal
            )
            .catch(reject);
        }).catch((err: Error) => err);
        record();
        if (reason instanceof Error) return openaiError(reply, 502, reason.message, 'upstream_error');
        return {
          id,
          object: 'chat.completion',
          created,
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: content || (calls.length ? null : ''),
                ...(reasoning ? { reasoning_content: reasoning } : {}),
                ...(calls.length ? { tool_calls: toolCallsOut(calls).map(({ index: _i, ...c }) => c) } : {}),
              },
              finish_reason: calls.length ? 'tool_calls' : reason === 'aborted' ? 'stop' : reason,
            },
          ],
          ...(usage ? { usage: usageOf(usage) } : {}),
        };
      }

      // Streaming: OpenAI chat.completion.chunk events, then [DONE]
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      let closed = false;
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
        closed = true;
      });
      const send = (payload: unknown) => !closed && res.write(`data: ${JSON.stringify(payload)}\n\n`);
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });

      chunk({ role: 'assistant', content: '' });
      let calls: ToolCall[] = [];
      const end = (reason: string) => {
        if (calls.length) chunk({ tool_calls: toolCallsOut(calls) });
        chunk({}, calls.length ? 'tool_calls' : reason);
        if (body.stream_options?.include_usage && usage) {
          send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: usageOf(usage) });
        }
        if (!closed) res.end('data: [DONE]\n\n');
      };
      await new Promise<void>((resolve) => {
        void target.provider
          .streamChatCompletion(
            request,
            {
              onChunk: (t) => chunk({ content: t }),
              onReasoning: (t) => chunk({ reasoning_content: t }),
              onToolCalls: (c) => (calls = c),
              onUsage: (u) => (usage = u),
              onComplete: (r) => {
                end(r === 'aborted' || !r ? 'stop' : r);
                resolve();
              },
              onError: (err) => {
                send({ error: { message: err.message, type: 'upstream_error' } });
                if (!closed) res.end('data: [DONE]\n\n');
                resolve();
              },
            },
            controller.signal
          )
          .catch((err: Error) => {
            send({ error: { message: err.message, type: 'upstream_error' } });
            if (!closed) res.end('data: [DONE]\n\n');
            resolve();
          });
      });
      record();
    }
  );
}
