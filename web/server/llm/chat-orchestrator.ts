/**
 * Server-side chat completions.
 *
 * `start` checks access, creates the user node and one assistant node per
 * model, registers the run and returns at once; the reply is produced in the
 * background and streamed through the run hub. A disconnected client doesn't
 * stop the run; POST /api/runs/:id/stop does.
 */
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client';
import { messages, usageEvents, users, type UserSettings } from '../db/schema';
import { badRequest } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import type { AuthUser } from '../auth/sessions';
import type { AppSettings } from '../modules/settings/app-settings';
import { ChatRepo, pathTo, toNode, type ChatRow } from '../modules/chats/repo';
import { toOpenAIMessages, type ResolvedFile, type ToOpenAIOptions } from '../../../src/services/chat/message-builder';
import { fitToContext } from '../../../src/services/chat/context-budget';
import { coerceEffort, resolveEffort, type ReasoningEffort } from '../../../src/utils/effort-utils';
import type { ChatCompletionRequest, ChatMessage } from '../../../src/types/api.types';
import type { ToolCall } from '../../../src/types/message.types';
import type { MessageNode, MessagePart } from '../../../src/types/turn.types';
import type { MessageUsage } from '../../../src/types/statistics.types';
import type { StreamEndReason } from '../../../src/services/api/sse-parser';
import type { CompletionRequest, CompletionResponse } from '../../shared/chats';
import type { RunStatus } from '../../shared/run-events';
import type { ModelRegistry, ResolvedModel } from './model-registry';
import type { Run, RunHub } from './run-hub';
import { PartsBuilder } from './parts-builder';
import { NO_TOOLS, type RunToolset } from './tools';
import { fallbackTitle, generateTitle } from './tasks';
import type { FileService } from '../modules/files/service';
import type { SkillService } from '../modules/skills/service';

/** Streaming replies are written to the database at most this often. */
const PERSIST_INTERVAL_MS = 500;

export interface OrchestratorDeps {
  db: Database;
  models: ModelRegistry;
  runs: RunHub;
  settings: AppSettings;
  log: FastifyBaseLogger;
  /** Tools from the user's MCP pools. */
  toolsFor?: (user: AuthUser, toolIds: string[]) => Promise<RunToolset>;
  /** Attachments (without it, fileIds are rejected). */
  files?: FileService;
  /** `/skill` invocations (without it, a skill in the request is rejected). */
  skills?: SkillService;
}

interface RunPlan {
  run: Run;
  user: AuthUser;
  chat: ChatRow;
  req: CompletionRequest;
  history: MessageNode[];
  userNode: MessageNode;
  /** The invoked skill's prompt, sent as a system message. */
  skillPrompt: string | null;
  targets: Array<{ assistantId: string; model: ResolvedModel }>;
}

function addUsage(a: MessageUsage | undefined, b: MessageUsage): MessageUsage {
  if (!a) return { ...b };
  return {
    ...b,
    prompt_tokens: (a.prompt_tokens ?? 0) + (b.prompt_tokens ?? 0),
    completion_tokens: (a.completion_tokens ?? 0) + (b.completion_tokens ?? 0),
    total_tokens: (a.total_tokens ?? 0) + (b.total_tokens ?? 0),
    ...(a.cost !== undefined || b.cost !== undefined ? { cost: (a.cost ?? 0) + (b.cost ?? 0) } : {}),
  };
}

export class ChatOrchestrator {
  private readonly repo: ChatRepo;

  constructor(private readonly deps: OrchestratorDeps) {
    this.repo = new ChatRepo(deps.db);
  }

  async start(user: AuthUser, chatId: string, req: CompletionRequest): Promise<CompletionResponse> {
    const { db, models, runs, settings } = this.deps;
    if (!req.content.trim() && req.fileIds.length === 0) throw badRequest('The message is empty.', 'empty_message');

    const chat = await this.repo.getOwned(user.id, chatId);
    const targetsResolved = await Promise.all(req.modelIds.map((id) => models.resolve(id, user.role, user.id)));
    const limits = await settings.get('limits');

    const all = (await this.repo.messages(chat.id)).map(toNode);
    if (req.parentId && !all.some((n) => n.id === req.parentId)) {
      throw badRequest('The message to reply to is not part of this chat.', 'invalid_parent');
    }
    const history = pathTo(all, req.parentId);

    // Attachments must be the user's own and ready
    const fileParts: MessagePart[] = [];
    if (req.fileIds.length > 0) {
      const rows = this.deps.files ? await this.deps.files.ownedByIds(user.id, req.fileIds) : [];
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of req.fileIds) {
        const row = byId.get(id);
        if (!row) throw badRequest('An attached file was not found.', 'file_not_found');
        if (row.status !== 'ready') throw badRequest(`"${row.name}" can't be read: ${row.error ?? 'still processing'}.`, 'file_not_ready');
        fileParts.push({ type: 'file', fileId: row.id, name: row.name, mime: row.mime, size: row.size });
      }
    }

    let skillPrompt: string | null = null;
    if (req.skill) {
      skillPrompt = this.deps.skills ? await this.deps.skills.resolve(user.id, req.skill.id, req.skill.args) : null;
      if (skillPrompt === null) throw badRequest(`There is no skill called /${req.skill.id}.`, 'skill_not_found');
    }

    const run = runs.start({
      userId: user.id,
      chatId: chat.id,
      lockKey: `${chat.id}:${req.parentId ?? 'root'}`,
      maxConcurrent: limits.concurrentRuns,
    });

    try {
      const now = new Date();
      const userNode: MessageNode = {
        id: uuidv7(),
        chatId: chat.id,
        parentId: req.parentId,
        role: 'user',
        parts: [...(req.content ? [{ type: 'text' as const, text: req.content }] : []), ...fileParts],
        ...(req.params.effort ? { effort: req.params.effort } : {}),
        status: 'completed',
        createdAt: now.toISOString(),
      };
      const targets = targetsResolved.map((model) => ({ assistantId: uuidv7(), model }));

      await db.transaction(async (tx) => {
        await tx.insert(messages).values({
          id: userNode.id,
          chatId: chat.id,
          parentId: userNode.parentId,
          role: 'user',
          parts: userNode.parts,
          effort: req.params.effort ?? null,
          status: 'completed',
          createdAt: now,
        });
        for (const t of targets) {
          await tx.insert(messages).values({
            id: t.assistantId,
            chatId: chat.id,
            parentId: userNode.id,
            role: 'assistant',
            parts: [],
            modelId: t.model.model.id,
            status: 'streaming',
            createdAt: now,
          });
        }
      });
      await this.repo.touch(chat.id, { currentLeafId: targets[0].assistantId, modelIds: req.modelIds });

      runs.emit(run, {
        type: 'run.started',
        runId: run.id,
        chatId: chat.id,
        userMessageId: userNode.id,
        assistantMessageIds: targets.map((t) => t.assistantId),
      });
      runs.emit(run, { type: 'message.created', message: userNode });
      for (const t of targets) {
        runs.emit(run, {
          type: 'message.created',
          message: {
            id: t.assistantId,
            chatId: chat.id,
            parentId: userNode.id,
            role: 'assistant',
            parts: [],
            modelId: t.model.model.id,
            status: 'streaming',
            createdAt: now.toISOString(),
          },
        });
      }

      const plan: RunPlan = { run, user, chat, req, history, userNode, skillPrompt, targets };
      void this.execute(plan).catch((err) => {
        this.deps.log.error({ err, runId: run.id }, 'run failed unexpectedly');
        runs.finish(run, 'error');
      });

      return { runId: run.id, userMessageId: userNode.id, assistantMessageIds: targets.map((t) => t.assistantId) };
    } catch (err) {
      runs.finish(run, 'error');
      throw err;
    }
  }

  private async execute(plan: RunPlan): Promise<void> {
    const { run, user, chat, req } = plan;
    const [userRow] = await this.deps.db.select({ settings: users.settings }).from(users).where(eq(users.id, user.id));
    const prefs = (userRow?.settings as UserSettings | undefined)?.preferences ?? {};

    // System prompts, most general first: the user's, each folder's, the chat's
    const system: ChatMessage[] = [];
    if (typeof prefs.systemPrompt === 'string' && prefs.systemPrompt.trim()) {
      system.push({ role: 'system', content: prefs.systemPrompt });
    }
    // Like the desktop: the skill follows the global prompt
    if (plan.skillPrompt) system.push({ role: 'system', content: plan.skillPrompt });
    for (const f of await this.repo.folderChain(user.id, chat.folderId)) {
      if (f.systemPrompt?.trim()) system.push({ role: 'system', content: f.systemPrompt });
    }
    if (chat.params.systemPrompt?.trim()) system.push({ role: 'system', content: chat.params.systemPrompt });

    const toolset = this.deps.toolsFor ? await this.deps.toolsFor(user, req.toolIds) : NO_TOOLS;
    const fileOpts = await this.fileOptions(user, [...plan.history, plan.userNode]);

    const results = await Promise.all(
      plan.targets.map((t, i) =>
        this.runModel(plan, t.assistantId, t.model, {
          system,
          prefs,
          toolset,
          fileOpts,
          reportTrim: i === 0,
        })
      )
    );

    const status: RunStatus = results.includes('completed')
      ? 'completed'
      : results.includes('stopped')
        ? 'stopped'
        : 'error';

    if (!chat.titleSet && !run.controller.signal.aborted) {
      await this.setTitle(plan, results).catch((err) =>
        this.deps.log.warn({ err: String(err), chatId: chat.id }, 'title generation failed')
      );
    }
    await this.repo.touch(chat.id);
    this.deps.runs.finish(run, status);
  }

  /** Produce one assistant reply (with its tool loop) and persist it. */
  private async runModel(
    plan: RunPlan,
    assistantId: string,
    target: ResolvedModel,
    opts: {
      system: ChatMessage[];
      prefs: Record<string, any>;
      toolset: RunToolset;
      fileOpts: ToOpenAIOptions;
      reportTrim: boolean;
    }
  ): Promise<RunStatus> {
    const { run, chat, req } = plan;
    const { runs, db, settings } = this.deps;
    const builder = new PartsBuilder();
    const limits = await settings.get('limits');
    const signal = run.controller.signal;
    const started = Date.now();
    let usage: MessageUsage | undefined;
    let status: RunStatus = 'completed';
    let error: string | undefined;

    const effort: ReasoningEffort | undefined = coerceEffort(
      resolveEffort(req.params.effort ?? null, null, opts.prefs.reasoningEffort ?? null),
      target.providerModelId
    );
    const temperature: number | undefined = req.params.temperature ?? chat.params.temperature ?? opts.prefs.temperature;

    const budget = fitToContext({
      model: target.providerModelId,
      contextWindow: target.model.contextLength,
      outputReserve: typeof opts.prefs.maxTokens === 'number' ? opts.prefs.maxTokens : undefined,
      system: opts.system,
      history: toOpenAIMessages(plan.history, opts.fileOpts),
      current: toOpenAIMessages([plan.userNode], opts.fileOpts),
    });
    if (opts.reportTrim) {
      if (budget.overflow) {
        runs.emit(run, {
          type: 'run.notice',
          code: 'context_overflow',
          message: 'This message may be too long for the model.',
        });
      } else if (budget.droppedTurns > 0) {
        runs.emit(run, {
          type: 'run.notice',
          code: 'history_trimmed',
          message: `The ${budget.droppedTurns} oldest exchange${budget.droppedTurns === 1 ? '' : 's'} didn't fit the model's context and were left out.`,
        });
      }
    }

    const persist = async (final = false) => {
      if (!builder.dirty && !final) return;
      builder.dirty = false;
      await db
        .update(messages)
        .set({
          parts: builder.parts,
          updatedAt: new Date(),
          ...(final ? { status, error: error ?? null, usage: usage ?? null } : {}),
        })
        .where(eq(messages.id, assistantId));
    };
    const ticker = setInterval(() => void persist().catch(() => {}), PERSIST_INTERVAL_MS);

    try {
      const tools = opts.toolset.definitions;
      const firstTurnOnly = opts.toolset.firstTurnOnly || !!target.connection.quirks.toolsFirstTurnOnly;
      for (let iteration = 0; ; iteration++) {
        const offerTools = tools.length > 0 && (iteration === 0 || !firstTurnOnly);
        // The turn so far, expanded into assistant(tool_calls) → tool rounds
        const turnSoFar = toOpenAIMessages([
          { id: assistantId, chatId: chat.id, parentId: null, role: 'assistant', parts: builder.parts, status: 'streaming', createdAt: '' },
        ]).filter((m) => m.role !== 'assistant' || m.tool_calls);

        const request: ChatCompletionRequest = {
          model: target.providerModelId,
          messages: [...budget.messages, ...turnSoFar],
          ...(temperature !== undefined ? { temperature } : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(offerTools ? { tools, tool_choice: 'auto' as const } : tools.length > 0 ? { tool_choice: 'none' as const } : {}),
        };

        let toolCalls: ToolCall[] = [];
        const reason = await this.stream(target, request, signal, {
          onText: (text) => {
            builder.appendText(text);
            runs.emit(run, { type: 'message.delta', messageId: assistantId, text });
          },
          onReasoning: (text) => {
            builder.appendReasoning(text);
            runs.emit(run, { type: 'message.reasoning', messageId: assistantId, text });
          },
          onUsage: (u) => {
            usage = addUsage(usage, u);
            runs.emit(run, { type: 'message.usage', messageId: assistantId, usage });
          },
          onToolCalls: (calls) => {
            toolCalls = calls;
          },
        });

        if (reason === 'aborted') {
          status = 'stopped';
          break;
        }
        if (toolCalls.length === 0) break;
        if (iteration + 1 >= limits.maxToolIterations) {
          status = 'error';
          error = 'Stopped after the maximum number of tool rounds.';
          break;
        }

        for (const call of toolCalls) {
          const where = opts.toolset.locate(call.function.name);
          const part = {
            type: 'tool_call' as const,
            callId: call.id,
            alias: call.function.name,
            serverId: where?.serverId ?? '',
            tool: where?.tool ?? call.function.name,
            args: call.function.arguments,
          };
          builder.add(part);
          runs.emit(run, { type: 'message.tool_call', messageId: assistantId, part });
        }
        for (const call of toolCalls) {
          if (signal.aborted) break;
          runs.emit(run, { type: 'tool.started', messageId: assistantId, callId: call.id });
          const exec = await opts.toolset.execute(call, signal);
          builder.add(exec.result);
          runs.emit(run, { type: 'tool.result', messageId: assistantId, part: exec.result });
        }
        if (signal.aborted) {
          status = 'stopped';
          break;
        }
      }
    } catch (err) {
      status = 'error';
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearInterval(ticker);
    }

    await persist(true);
    runs.emit(run, {
      type: 'message.completed',
      messageId: assistantId,
      status,
      ...(error ? { error } : {}),
      parts: builder.parts,
    });

    if (usage) {
      await db
        .insert(usageEvents)
        .values({
          id: uuidv7(),
          userId: plan.user.id,
          chatId: chat.id,
          modelId: target.model.id,
          connectionId: target.connection.id,
          kind: 'chat',
          promptTokens: usage.prompt_tokens ?? 0,
          completionTokens: usage.completion_tokens ?? 0,
          cost: usage.cost ?? null,
          latencyMs: Date.now() - started,
        })
        .catch((err) => this.deps.log.warn({ err: String(err) }, 'recording usage failed'));
    }
    return status;
  }

  /**
   * Load what the model sees of every attachment on the path up front, so
   * message building stays synchronous. Files deleted since are left out.
   */
  private async fileOptions(user: AuthUser, nodes: MessageNode[]): Promise<ToOpenAIOptions> {
    const ids = [...new Set(nodes.flatMap((n) => n.parts.flatMap((p) => (p.type === 'file' ? [p.fileId] : []))))];
    if (ids.length === 0 || !this.deps.files) return {};
    const resolved = new Map<string, ResolvedFile>();
    for (const row of await this.deps.files.ownedByIds(user.id, ids)) {
      const view = await this.deps.files.forModel(row).catch(() => null);
      if (view) resolved.set(row.id, view);
    }
    return { resolveFile: (part) => resolved.get(part.fileId) ?? null };
  }

  /** One provider call as a promise of its end reason. */
  private stream(
    target: ResolvedModel,
    request: ChatCompletionRequest,
    signal: AbortSignal,
    on: {
      onText: (t: string) => void;
      onReasoning: (t: string) => void;
      onUsage: (u: MessageUsage) => void;
      onToolCalls: (c: ToolCall[]) => void;
    }
  ): Promise<Exclude<StreamEndReason, 'error'>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      target.provider
        .streamChatCompletion(
          request,
          {
            onChunk: on.onText,
            onReasoning: on.onReasoning,
            onUsage: on.onUsage,
            onToolCalls: on.onToolCalls,
            onComplete: (reason) => {
              if (settled) return;
              settled = true;
              resolve(signal.aborted ? 'aborted' : (reason ?? 'stop'));
            },
            onError: (err) => {
              if (settled) return;
              settled = true;
              reject(err);
            },
          },
          signal
        )
        .catch((err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
    });
  }

  /** First exchange done: name the chat (model-generated, or the first line). */
  private async setTitle(plan: RunPlan, results: RunStatus[]): Promise<void> {
    const { chat, run } = plan;
    const userText = plan.userNode.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const firstOk = plan.targets[results.indexOf('completed')];
    let title = fallbackTitle(userText);

    const tasks = await this.deps.settings.get('tasks');
    if (tasks.generateTitles && firstOk) {
      try {
        const [row] = await this.deps.db.select().from(messages).where(eq(messages.id, firstOk.assistantId));
        const assistantText = (row?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
        // The task model is the admin's choice, so the user's allowlist doesn't apply
        const model = tasks.titleModel
          ? await this.deps.models.resolve(tasks.titleModel, 'admin').catch(() => firstOk.model)
          : firstOk.model;
        title = await generateTitle(model.provider, model.providerModelId, userText, assistantText);
      } catch (err) {
        this.deps.log.warn({ err: String(err), chatId: chat.id }, 'model title failed; using the first line');
      }
    }
    await this.repo.touch(chat.id, { title, titleSet: true });
    this.deps.runs.emit(run, { type: 'chat.updated', chatId: chat.id, title });
  }
}
