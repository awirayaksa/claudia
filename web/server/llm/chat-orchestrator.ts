/**
 * Server-side chat completions.
 *
 * `start` checks access, creates the user node and one assistant node per
 * model, registers the run and returns at once; the reply is produced in the
 * background and streamed through the run hub. A disconnected client doesn't
 * stop the run; POST /api/runs/:id/stop does.
 */
import { eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client';
import { messages, usageEvents, users, type MessageMeta, type UserSettings } from '../db/schema';
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
import type { MessageNode, MessagePart, PartOf } from '../../../src/types/turn.types';
import type { MessageUsage } from '../../../src/types/statistics.types';
import type { StreamEndReason } from '../../../src/services/api/sse-parser';
import type { CompletionRequest, CompletionResponse } from '../../shared/chats';
import type { RunStatus } from '../../shared/run-events';
import type { ModelRegistry, ResolvedModel } from './model-registry';
import type { Run, RunHub } from './run-hub';
import { PartsBuilder } from './parts-builder';
import { NO_TOOLS, type RunToolset } from './tools';
import { fallbackTitle, generateFollowUps, generateTitle } from './tasks';
import type { FileService } from '../modules/files/service';
import type { SkillService } from '../modules/skills/service';
import type { UsageService } from '../modules/usage/service';
import { memoryPrompt } from '../modules/memories/routes';
import type { AccessService } from '../auth/access';
import type { RagConfig } from '../rag/config';
import type { KnowledgeService } from '../rag/knowledge';
import { readableKbIds, sourcesPrompt, type SourceBuilder, type TurnSource } from '../rag/sources';
import type { MessageRef } from '../../shared/knowledge';
import { fillSystemVariables, type SystemValues } from '../../shared/prompts';

/** Streaming replies are written to the database at most this often. */
const PERSIST_INTERVAL_MS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrchestratorDeps {
  db: Database;
  models: ModelRegistry;
  runs: RunHub;
  settings: AppSettings;
  log: FastifyBaseLogger;
  /** Tools from the user's MCP pools (`alwaysOn`: a custom model's, used even if the user switched them off). */
  toolsFor?: (user: AuthUser, toolIds: string[], alwaysOn: string[]) => Promise<RunToolset>;
  /** Token and cost caps (without it, nothing is capped). */
  usage?: UsageService;
  /** Attachments (without it, fileIds are rejected). */
  files?: FileService;
  /** `/skill` invocations (without it, a skill in the request is rejected). */
  skills?: SkillService;
  /** Knowledge, #url / #chat references and web search (without them, references are rejected). */
  access?: AccessService;
  sources?: SourceBuilder;
  knowledge?: KnowledgeService;
  rag?: RagConfig;
}

/** Above this much memory text, only the memories closest to the message are sent (with embeddings). */
const MEMORY_ALL_CHARS = 2000;

interface RunPlan {
  run: Run;
  user: AuthUser;
  chat: ChatRow;
  req: CompletionRequest;
  history: MessageNode[];
  userNode: MessageNode;
  /** The invoked skill's prompt, sent as a system message. */
  skillPrompt: string | null;
  /** #kb / #url / #chat references and web search of this turn (checked). */
  refs: MessageRef[];
  webSearch: boolean;
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
    if (!req.regenerate && !req.content.trim() && req.fileIds.length === 0) {
      throw badRequest('The message is empty.', 'empty_message');
    }

    const chat = await this.repo.getOwned(user.id, chatId);
    await this.deps.usage?.check(user);
    const targetsResolved = await Promise.all(req.modelIds.map((id) => models.resolve(id, user.role, user.id)));
    const limits = await settings.get('limits');

    const rows = await this.repo.messages(chat.id);
    const all = rows.map(toNode);
    if (req.parentId && !all.some((n) => n.id === req.parentId)) {
      throw badRequest('The message to reply to is not part of this chat.', 'invalid_parent');
    }

    // Regenerating: answer an existing user turn again, as new sibling replies
    const existing = req.regenerate ? rows.find((r) => r.id === req.parentId) : undefined;
    if (req.regenerate && (!existing || existing.role !== 'user')) {
      throw badRequest('Only a message you sent can be answered again.', 'invalid_parent');
    }

    // Attachments must be the user's own and ready
    const fileParts: MessagePart[] = [];
    if (!existing && req.fileIds.length > 0) {
      const files = this.deps.files ? await this.deps.files.ownedByIds(user.id, req.fileIds) : [];
      const byId = new Map(files.map((r) => [r.id, r]));
      for (const id of req.fileIds) {
        const row = byId.get(id);
        if (!row) throw badRequest('An attached file was not found.', 'file_not_found');
        if (row.status !== 'ready') throw badRequest(`"${row.name}" can't be read: ${row.error ?? 'still processing'}.`, 'file_not_ready');
        fileParts.push({ type: 'file', fileId: row.id, name: row.name, mime: row.mime, size: row.size });
      }
    }

    // The skill of a regenerated turn is the one it was sent with
    const skill = existing ? existing.meta?.skill : req.skill;
    let skillPrompt: string | null = null;
    if (skill) {
      skillPrompt = this.deps.skills ? await this.deps.skills.resolve(user.id, skill.id, skill.args) : null;
      if (skillPrompt === null) throw badRequest(`There is no skill called /${skill.id}.`, 'skill_not_found');
    }

    // References and web search: a regeneration uses the turn's own
    const refs: MessageRef[] = existing ? (existing.meta?.refs ?? []) : req.refs;
    const webSearch = existing ? !!existing.meta?.webSearch : req.features.webSearch === true;
    await this.checkRefs(user, refs, webSearch);

    const run = runs.start({
      userId: user.id,
      chatId: chat.id,
      // One run per branch: new turns lock the node they follow, regenerations the turn they answer
      lockKey: existing ? `${chat.id}:answers:${existing.id}` : `${chat.id}:${req.parentId ?? 'root'}`,
      maxConcurrent: limits.concurrentRuns,
    });

    try {
      const now = new Date();
      let userNode: MessageNode;
      let newUserRow: typeof messages.$inferInsert | null = null;
      if (existing) {
        userNode = toNode(existing);
      } else {
        const meta: MessageMeta = {
          ...(req.modelIds.length > 1 ? { models: req.modelIds } : {}),
          ...(req.skill ? { skill: req.skill } : {}),
          ...(refs.length ? { refs } : {}),
          ...(webSearch ? { webSearch: true } : {}),
        };
        userNode = {
          id: uuidv7(),
          chatId: chat.id,
          parentId: req.parentId,
          role: 'user',
          parts: [...(req.content ? [{ type: 'text' as const, text: req.content }] : []), ...fileParts],
          ...(req.params.effort ? { effort: req.params.effort } : {}),
          ...(meta.models ? { models: meta.models } : {}),
          status: 'completed',
          createdAt: now.toISOString(),
        };
        newUserRow = {
          id: userNode.id,
          chatId: chat.id,
          parentId: userNode.parentId,
          role: 'user',
          parts: userNode.parts,
          effort: req.params.effort ?? null,
          status: 'completed',
          meta,
          createdAt: now,
        };
      }
      const history = pathTo(all, userNode.parentId);
      const targets = targetsResolved.map((model) => ({ assistantId: uuidv7(), model }));

      await db.transaction(async (tx) => {
        if (newUserRow) await tx.insert(messages).values(newUserRow);
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
      // Answering one turn again doesn't change which models the chat uses
      await this.repo.touch(chat.id, { currentLeafId: targets[0].assistantId, ...(existing ? {} : { modelIds: req.modelIds }) });

      runs.emit(run, {
        type: 'run.started',
        runId: run.id,
        chatId: chat.id,
        userMessageId: userNode.id,
        assistantMessageIds: targets.map((t) => t.assistantId),
      });
      if (!existing) runs.emit(run, { type: 'message.created', message: userNode });
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

      // A regeneration without its own effort uses the turn's
      const effectiveReq: CompletionRequest =
        existing && req.params.effort === undefined && userNode.effort
          ? { ...req, params: { ...req.params, effort: userNode.effort } }
          : req;
      const plan: RunPlan = { run, user, chat, req: effectiveReq, history, userNode, skillPrompt, targets, refs, webSearch };
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
    const userSettings = (userRow?.settings as UserSettings | undefined) ?? {};
    const prefs = userSettings.preferences ?? {};
    const vars: SystemValues = { userName: user.name };
    const sys = (content: string): ChatMessage => ({ role: 'system', content: fillSystemVariables(content, vars) });

    // System prompts, most general first: the user's, the custom model's,
    // memories, the skill, each folder's, the chat's
    const before: ChatMessage[] = [];
    if (typeof prefs.systemPrompt === 'string' && prefs.systemPrompt.trim()) before.push(sys(prefs.systemPrompt));
    const after: ChatMessage[] = [];
    const userText = plan.userNode.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    if (userSettings.memory?.enabled !== false) {
      const memory = await memoryPrompt(this.deps.db, user.id, (total) => this.relevantMemories(user.id, userText, total));
      if (memory) after.push({ role: 'system', content: memory });
    }
    // Like the desktop: the skill follows the global prompt
    if (plan.skillPrompt) after.push({ role: 'system', content: plan.skillPrompt });
    for (const f of await this.repo.folderChain(user.id, chat.folderId)) {
      if (f.systemPrompt?.trim()) after.push(sys(f.systemPrompt));
    }
    if (chat.params.systemPrompt?.trim()) after.push(sys(chat.params.systemPrompt));

    // Sources (knowledge, references, web), numbered for citations, last
    const sources = await this.gatherSources(plan, userText).catch((err) => {
      this.deps.log.warn({ err: String(err), runId: run.id }, 'gathering sources failed');
      this.deps.runs.emit(run, { type: 'run.notice', code: 'sources_failed', message: `Sources couldn't be loaded: ${err instanceof Error ? err.message : String(err)}` });
      return [] as TurnSource[];
    });
    if (sources.length > 0) after.push({ role: 'system', content: sourcesPrompt(sources) });

    // A custom model's tools are on whenever it answers
    const toolsets = new Map<string, Promise<RunToolset>>();
    const toolsetFor = (target: ResolvedModel) => {
      const alwaysOn = target.custom?.toolIds ?? [];
      const key = alwaysOn.join('\n');
      if (!toolsets.has(key)) {
        toolsets.set(
          key,
          this.deps.toolsFor ? this.deps.toolsFor(user, [...new Set([...req.toolIds, ...alwaysOn])], alwaysOn) : Promise.resolve(NO_TOOLS)
        );
      }
      return toolsets.get(key)!;
    };
    const fileOpts = await this.fileOptions(user, [...plan.history, plan.userNode]);

    const results = await Promise.all(
      plan.targets.map(async (t, i) =>
        this.runModel(plan, t.assistantId, t.model, {
          system: [...before, ...(t.model.custom?.systemPrompt.trim() ? [sys(t.model.custom.systemPrompt)] : []), ...after],
          prefs,
          toolset: await toolsetFor(t.model),
          fileOpts,
          reportTrim: i === 0,
          citations: sources.map((src) => ({ type: 'citation' as const, index: src.index, source: src.source })),
        })
      )
    );

    const status: RunStatus = results.includes('completed')
      ? 'completed'
      : results.includes('stopped')
        ? 'stopped'
        : 'error';

    // Background tasks once the replies are in (temporary chats get no title)
    if (!run.controller.signal.aborted && !chat.titleSet && !chat.temporary) {
      await this.setTitle(plan, results).catch((err) =>
        this.deps.log.warn({ err: String(err), chatId: chat.id }, 'title generation failed')
      );
    }
    if (!run.controller.signal.aborted) {
      await this.setFollowUps(plan, results).catch((err) =>
        this.deps.log.warn({ err: String(err), chatId: chat.id }, 'follow-up suggestions failed')
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
      citations: Array<PartOf<'citation'>>;
    }
  ): Promise<RunStatus> {
    const { run, chat, req } = plan;
    const { runs, db, settings } = this.deps;
    const builder = new PartsBuilder();
    for (const c of opts.citations) builder.add(c);
    if (opts.citations.length > 0) {
      runs.emit(run, {
        type: 'message.citations',
        messageId: assistantId,
        citations: opts.citations.map((c) => ({ index: c.index, source: c.source })),
      });
    }
    const limits = await settings.get('limits');
    const signal = run.controller.signal;
    const started = Date.now();
    let usage: MessageUsage | undefined;
    let status: RunStatus = 'completed';
    let error: string | undefined;

    // Request, then chat, then custom model, then the user's preferences
    const model = target.custom?.params ?? {};
    const effort: ReasoningEffort | undefined = coerceEffort(
      resolveEffort(req.params.effort ?? null, model.effort ?? null, opts.prefs.reasoningEffort ?? null),
      target.providerModelId
    );
    const temperature: number | undefined =
      req.params.temperature ?? chat.params.temperature ?? model.temperature ?? opts.prefs.temperature;
    const maxTokens = chat.params.maxTokens ?? model.maxTokens;
    const topP = chat.params.topP ?? model.topP;
    const frequencyPenalty = chat.params.frequencyPenalty ?? model.frequencyPenalty;
    const presencePenalty = chat.params.presencePenalty ?? model.presencePenalty;

    const budget = fitToContext({
      model: target.providerModelId,
      contextWindow: target.model.contextLength,
      outputReserve: maxTokens ?? (typeof opts.prefs.maxTokens === 'number' ? opts.prefs.maxTokens : undefined),
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
          ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
          ...(topP !== undefined ? { top_p: topP } : {}),
          ...(frequencyPenalty !== undefined ? { frequency_penalty: frequencyPenalty } : {}),
          ...(presencePenalty !== undefined ? { presence_penalty: presencePenalty } : {}),
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
    // Imported and shared chats keep attachment names only (empty ids)
    const ids = [
      ...new Set(nodes.flatMap((n) => n.parts.flatMap((p) => (p.type === 'file' && UUID.test(p.fileId) ? [p.fileId] : [])))),
    ];
    if (ids.length === 0 || !this.deps.files) return {};
    const resolved = new Map<string, ResolvedFile>();
    for (const row of await this.deps.files.ownedByIds(user.id, ids)) {
      const view = await this.deps.files.forModel(row).catch(() => null);
      if (view) resolved.set(row.id, view);
    }
    return { resolveFile: (part) => resolved.get(part.fileId) ?? null };
  }

  /** Refuse references the user can't use (before the run starts). */
  private async checkRefs(user: AuthUser, refs: MessageRef[], webSearch: boolean): Promise<void> {
    if (refs.length === 0 && !webSearch) return;
    const { access, sources, rag } = this.deps;
    if (!access || !sources || !rag) throw badRequest('References are not available here.', 'refs_unavailable');
    for (const r of refs) {
      if (r.type === 'chat') await this.repo.getOwned(user.id, r.id);
      if (r.type === 'kb') {
        const ok = await readableKbIds(this.deps.db, [r.id], async (kb) => (await access.rights(user, 'knowledge', kb)).read);
        if (ok.length === 0) throw badRequest('A referenced knowledge base was not found.', 'kb_not_found');
      }
    }
    if (webSearch) {
      await access.require(user, 'features.web_search');
      if ((await rag.settings()).webSearch.engine === 'none') throw badRequest('Web search is not set up on this server.', 'web_search_off');
    }
  }

  /**
   * Knowledge bases from #kb references and the chat's folders (with the
   * user's access) and from custom models (with their owner's), plus
   * referenced chats, #url pages and web search.
   */
  private async gatherSources(plan: RunPlan, query: string): Promise<TurnSource[]> {
    const { access, sources } = this.deps;
    if (!access || !sources) return [];
    const { user, chat, refs } = plan;
    const folderKbs = (await this.repo.folderChain(user.id, chat.folderId)).flatMap((f) => f.knowledgeIds ?? []);
    const mine = [...refs.flatMap((r) => (r.type === 'kb' ? [r.id] : [])), ...folderKbs];
    const kbIds = new Set(await readableKbIds(this.deps.db, mine, async (kb) => (await access.rights(user, 'knowledge', kb)).read));
    for (const t of plan.targets) {
      const custom = t.model.custom;
      if (!custom?.knowledgeIds.length) continue;
      const [owner] = await this.deps.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, custom.ownerId));
      if (!owner) continue;
      for (const id of await readableKbIds(this.deps.db, custom.knowledgeIds, async (kb) => (await access.rights(owner, 'knowledge', kb)).read)) {
        kbIds.add(id);
      }
    }
    const urls = refs.flatMap((r) => (r.type === 'url' ? [r.url] : []));
    const chatIds = refs.flatMap((r) => (r.type === 'chat' ? [r.id] : []));
    if (kbIds.size === 0 && urls.length === 0 && chatIds.length === 0 && !plan.webSearch) return [];

    const built = await sources.build({ userId: user.id, query, kbIds: [...kbIds], urls, chatIds, webSearch: plan.webSearch });
    for (const message of built.notices) this.deps.runs.emit(plan.run, { type: 'run.notice', code: 'sources', message });
    return built.sources;
  }

  /** With embeddings and many memories: the ones closest to the message. */
  private async relevantMemories(userId: string, query: string, totalChars: number): Promise<string[] | null> {
    if (totalChars <= MEMORY_ALL_CHARS || !this.deps.knowledge) return null;
    const picked = await this.deps.knowledge.searchMemories(userId, query, 8).catch(() => []);
    return picked.length > 0 ? picked : null;
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

  /** The model (task model, else the reply's) for a background task. */
  private async taskModel(fallback: ResolvedModel): Promise<ResolvedModel> {
    const tasks = await this.deps.settings.get('tasks');
    // The task model is the admin's choice, so the user's allowlist doesn't apply
    return tasks.titleModel ? await this.deps.models.resolve(tasks.titleModel, 'admin').catch(() => fallback) : fallback;
  }

  private async replyText(messageId: string): Promise<string> {
    const [row] = await this.deps.db.select({ parts: messages.parts }).from(messages).where(eq(messages.id, messageId));
    return (row?.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('');
  }

  /** Suggested next questions under the first finished reply. */
  private async setFollowUps(plan: RunPlan, results: RunStatus[]): Promise<void> {
    const tasks = await this.deps.settings.get('tasks');
    const target = plan.targets[results.indexOf('completed')];
    if (!tasks.generateFollowUps || !target) return;
    const userText = plan.userNode.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const assistantText = await this.replyText(target.assistantId);
    if (!assistantText.trim()) return;
    const model = await this.taskModel(target.model);
    const followUps = await generateFollowUps(model.provider, model.providerModelId, userText, assistantText);
    if (followUps.length === 0) return;
    await this.deps.db
      .update(messages)
      .set({ meta: sql`${messages.meta} || ${JSON.stringify({ followUps })}::jsonb` })
      .where(eq(messages.id, target.assistantId));
    this.deps.runs.emit(plan.run, { type: 'message.followups', messageId: target.assistantId, followUps });
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
        const assistantText = await this.replyText(firstOk.assistantId);
        const model = await this.taskModel(firstOk.model);
        title = await generateTitle(model.provider, model.providerModelId, userText, assistantText);
      } catch (err) {
        this.deps.log.warn({ err: String(err), chatId: chat.id }, 'model title failed; using the first line');
      }
    }
    await this.repo.touch(chat.id, { title, titleSet: true });
    this.deps.runs.emit(run, { type: 'chat.updated', chatId: chat.id, title });
  }
}
