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
import { chats, messages, usageEvents, users, type MessageMeta, type UserSettings, notes } from '../db/schema';
import { badRequest } from '../lib/errors';
import { uuidv7 } from '../lib/ids';
import type { AuthUser } from '../auth/sessions';
import type { AppSettings } from '../modules/settings/app-settings';
import { ChatRepo, pathTo, toNode, type ChatRow } from '../modules/chats/repo';
import { toOpenAIMessages, type ResolvedFile, type ToOpenAIOptions } from '../../../src/services/chat/message-builder';
import {
  compactionMessage,
  estimateMessagesTokens,
  fitToContext,
  planCompaction,
  promptLimit,
} from '../../../src/services/chat/context-budget';
import { coerceEffort, resolveEffort, type ReasoningEffort } from '../../../src/utils/effort-utils';
import { VISUAL_EXPLANATIONS_PROMPT } from '../../../src/utils/visual-explanations';
import type { ChatCompletionRequest, ChatMessage } from '../../../src/types/api.types';
import type { ToolCall } from '../../../src/types/message.types';
import type { MessageNode, MessagePart, PartOf } from '../../../src/types/turn.types';
import type { MessageUsage } from '../../../src/types/statistics.types';
import type { StreamEndReason } from '../../../src/services/api/sse-parser';
import type { CompletionRequest, CompletionResponse } from '../../shared/chats';
import type { RunStatus } from '../../shared/run-events';
import type { ModelRegistry, ResolvedModel } from './model-registry';
import type { ClientToolResult, Run, RunHub } from './run-hub';
import { PartsBuilder } from './parts-builder';
import { NO_TOOLS, type RunToolset } from './tools';
import { fallbackTitle, generateFollowUps, generateTitle } from './tasks';
import type { FileService } from '../modules/files/service';
import type { SkillService } from '../modules/skills/service';
import type { UsageService } from '../modules/usage/service';
import type { MemoryStore } from '../modules/memories/store';
import type { FolderService } from '../modules/chats/folders';
import { MemoryLearner } from '../modules/memories/learn';
import { MEMORY_TOOL_NAMES, memoryToolDefinitions, runMemoryTool } from '../modules/memories/tools';
import type { AccessService } from '../auth/access';
import type { RagConfig } from '../rag/config';
import type { KnowledgeService } from '../rag/knowledge';
import { readableKbIds, sourcesPrompt, type SourceBuilder, type TurnSource } from '../rag/sources';
import type { MessageRef } from '../../shared/knowledge';
import { CLIENT_TOOL_NAMES, CODE_TOOL, NO_BROWSER_MESSAGE } from './client-tools';
import { activeCodeEngine, RUN_CODE_TOOL, RUN_CODE_TOOL_NAME, runSummary as codeRunSummary, type CodeSandbox } from '../code/sandbox';
import { workspaceMime } from '../../shared/workspace-files';
import { resolveStyle, stylePrompt } from '../modules/styles/routes';
import { CHAT_SEARCH_TOOL_NAMES, CHAT_SEARCH_TOOLS, ChatSearch, runChatSearchTool } from '../modules/chats/chat-search';
import { isBuiltinStyle } from '../../shared/styles';
import { generateImage, IMAGE_TOOL, IMAGE_TOOL_NAME } from '../media/images';
import type { MediaConfig } from '../media/config';
import type { Webhooks } from '../admin/webhooks';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { withSpan } from '../telemetry';
import { ARENA_LABELS, ARENA_MODEL_ID } from '../../shared/arena';
import type { ToolExecution } from './tools';
import { fillSystemVariables, type SystemValues } from '../../shared/prompts';
import { latestCompaction, nodeTurns, summarize } from './compaction';

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
  /** Whether a sandbox origin exists (browser tools run there); without it, the browser code interpreter is off. */
  sandboxOrigin?: string | null;
  /** Server-side code runs (without it, code runs in the browser only). */
  code?: CodeSandbox;
  /** How long a browser tool may take to answer (default 120 s). */
  clientToolTimeoutMs?: number;
  /** Image generation (without it, it is off). */
  media?: MediaConfig;
  /** run.completed goes to admin webhooks. */
  webhooks?: Webhooks;
  /** Folders shared with the user (without it, only their own folders apply). */
  folders?: FolderService;
  /** Memories (without them, none are sent or learned). */
  memories?: MemoryStore;
  memoryLearner?: MemoryLearner;
  /** How long a chat stays quiet before it is read for memories (default 2 minutes). */
  memoryIdleMs?: number;
}

/** What admin webhooks hear about a finished run (no message text). */
function runSummary(plan: RunPlan, status: RunStatus) {
  const usage = { promptTokens: 0, completionTokens: 0 };
  for (const { event } of plan.run.events) {
    if (event.type !== 'message.usage') continue;
    usage.promptTokens += event.usage.prompt_tokens ?? 0;
    usage.completionTokens += event.usage.completion_tokens ?? 0;
  }
  return {
    runId: plan.run.id,
    chatId: plan.chat.id,
    userId: plan.user.id,
    status,
    models: plan.targets.map((t) => t.model.model.id),
    assistantMessageIds: plan.targets.map((t) => t.assistantId),
    usage,
    durationMs: Date.now() - plan.run.startedAt,
  };
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
  /** The code interpreter (runs in the browser) is offered. */
  code: boolean;
  /** The image generation tool is offered. */
  imageGen: boolean;
  /** Where the code interpreter runs, when it is offered. */
  codeEngine: 'browser' | 'server' | null;
  /** Continuing this reply (cut off at the output limit): it keeps its parts and grows. */
  continueNode: MessageNode | null;
  /** The writing style of the turn. */
  style: { id: string; name: string; instructions: string } | null;
  /** The model may search the user's earlier chats. */
  pastChats: boolean;
  targets: Array<{ assistantId: string; model: ResolvedModel }>;
}

/** What continuing a cut-off reply sends after the conversation. */
export function continuationMessages(reply: MessageNode, prefill: boolean): ChatMessage[] {
  const rounds = toOpenAIMessages([{ ...reply, status: 'completed' }]);
  const last = rounds[rounds.length - 1];
  // Anthropic carries on from a final assistant message (which must not end in whitespace)
  if (prefill && last?.role === 'assistant' && typeof last.content === 'string' && last.content.trim()) {
    return [...rounds.slice(0, -1), { ...last, content: last.content.trimEnd() }];
  }
  return [
    ...rounds,
    {
      role: 'user',
      content:
        'Your reply above was cut off at the output limit. Continue it exactly where it stopped, mid-word or mid-line if needed: ' +
        "no greeting, no summary of what you said, and don't repeat anything. If you were inside a code block, keep writing the code without opening a new block.",
    },
  ];
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
  private readonly chatSearch: ChatSearch;

  constructor(private readonly deps: OrchestratorDeps) {
    this.repo = new ChatRepo(deps.db);
    this.chatSearch = new ChatSearch(deps.db);
  }

  async start(user: AuthUser, chatId: string, req: CompletionRequest): Promise<CompletionResponse> {
    const { db, models, runs, settings } = this.deps;
    if (!req.regenerate && !req.continueId && !req.content.trim() && req.fileIds.length === 0) {
      throw badRequest('The message is empty.', 'empty_message');
    }

    const chat = await this.repo.getOwned(user.id, chatId);
    await this.deps.usage?.check(user);
    const rows = await this.repo.messages(chat.id);
    const all = rows.map(toNode);

    // Continuing: the same reply carries on, by the model that wrote it
    const continuing = req.continueId ? rows.find((r) => r.id === req.continueId) : undefined;
    if (req.continueId && (!continuing || continuing.role !== 'assistant' || continuing.status === 'streaming' || !continuing.modelId)) {
      throw badRequest('Only a finished reply can be continued.', 'invalid_continue');
    }

    // "Arena": two eligible models, picked at random, answer without their names
    const arena = continuing ? null : await this.arenaPick(user, req);
    const modelIds = continuing ? [continuing.modelId!] : arena ? arena.models : req.modelIds;
    const targetsResolved = await Promise.all(modelIds.map((id) => models.resolve(id, user.role, user.id)));
    const limits = await settings.get('limits');

    const parentId = continuing ? continuing.parentId : req.parentId;
    if (parentId && !all.some((n) => n.id === parentId)) {
      throw badRequest('The message to reply to is not part of this chat.', 'invalid_parent');
    }

    // Regenerating: answer an existing user turn again, as new sibling replies (continuing: the turn it answers)
    const existing = req.regenerate || continuing ? rows.find((r) => r.id === parentId) : undefined;
    if ((req.regenerate || continuing) && (!existing || existing.role !== 'user')) {
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
    const code = existing ? !!existing.meta?.code : req.features.code === true;
    const codeEngine = code ? await this.checkCode(user) : null;
    const imageGen = existing ? !!existing.meta?.imageGen : req.features.imageGen === true;
    if (imageGen) await this.checkImageGen(user);
    const pastChats = existing ? !!existing.meta?.pastChats : req.features.pastChats === true;
    await this.checkRefs(user, refs, webSearch);
    // The writing style: a regeneration (or continuation) keeps the turn's
    const styleId = existing ? existing.meta?.style : req.styleId;
    const style =
      styleId && (isBuiltinStyle(styleId) || this.deps.access)
        ? await resolveStyle({ db: this.deps.db, access: this.deps.access! }, user, styleId)
        : null;
    if (!existing && styleId && !style && styleId !== 'normal') throw badRequest('That writing style was not found.', 'style_not_found');

    const run = await runs.start({
      userId: user.id,
      chatId: chat.id,
      // One run per branch: new turns lock the node they follow, regenerations the turn they answer
      lockKey: continuing ? `${chat.id}:continue:${continuing.id}` : existing ? `${chat.id}:answers:${existing.id}` : `${chat.id}:${req.parentId ?? 'root'}`,
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
          ...(arena ? { models: [...ARENA_LABELS], arena: { models: arena.models } } : req.modelIds.length > 1 ? { models: req.modelIds } : {}),
          ...(req.skill ? { skill: req.skill } : {}),
          ...(refs.length ? { refs } : {}),
          ...(webSearch ? { webSearch: true } : {}),
          ...(code ? { code: true } : {}),
          ...(imageGen ? { imageGen: true } : {}),
          ...(style ? { style: style.id } : {}),
          ...(pastChats ? { pastChats: true } : {}),
        };
        userNode = {
          id: uuidv7(),
          chatId: chat.id,
          parentId: req.parentId,
          role: 'user',
          parts: [...(req.content ? [{ type: 'text' as const, text: req.content }] : []), ...fileParts],
          ...(req.params.effort ? { effort: req.params.effort } : {}),
          ...(meta.models ? { models: meta.models } : {}),
          ...(arena ? { arena: { winner: null, models: null } } : {}),
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
      const targets = targetsResolved.map((model) => ({ assistantId: continuing?.id ?? uuidv7(), model }));
      const continueNode = continuing ? toNode(continuing) : null;

      await db.transaction(async (tx) => {
        if (newUserRow) await tx.insert(messages).values(newUserRow);
        if (continuing) {
          await tx.update(messages).set({ status: 'streaming', error: null, updatedAt: now }).where(eq(messages.id, continuing.id));
          return;
        }
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
      // The chat remembers the style last used
      const chatStyle = style?.id ?? null;
      if (!existing && (chat.params.styleId ?? null) !== chatStyle) {
        const { styleId: _old, ...params } = chat.params;
        await db.update(chats).set({ params: chatStyle ? { ...params, styleId: chatStyle } : params }).where(eq(chats.id, chat.id));
      }

      runs.emit(run, {
        type: 'run.started',
        runId: run.id,
        chatId: chat.id,
        userMessageId: userNode.id,
        assistantMessageIds: targets.map((t) => t.assistantId),
      });
      if (!existing) runs.emit(run, { type: 'message.created', message: userNode });
      if (continueNode) {
        const { stopReason: _stopped, ...rest } = continueNode;
        runs.emit(run, { type: 'message.created', message: { ...rest, status: 'streaming' } });
      }
      for (const t of continueNode ? [] : targets) {
        runs.emit(run, {
          type: 'message.created',
          message: {
            id: t.assistantId,
            chatId: chat.id,
            parentId: userNode.id,
            role: 'assistant',
            parts: [],
            // Unnamed until the vote
            modelId: arena ? ARENA_LABELS[arena.models.indexOf(t.model.model.id)] : t.model.model.id,
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
      const plan: RunPlan = {
        run,
        user,
        chat,
        req: effectiveReq,
        history,
        userNode,
        skillPrompt,
        targets,
        refs,
        webSearch,
        code,
        codeEngine,
        imageGen,
        continueNode,
        style,
        pastChats,
      };
      void withSpan('claudia.run', { 'claudia.run_id': run.id, 'claudia.chat_id': chat.id, 'enduser.id': user.id }, () => this.execute(plan)).catch((err) => {
        this.deps.log.error({ err, runId: run.id }, 'run failed unexpectedly');
        runs.finish(run, 'error');
      });

      return { runId: run.id, userMessageId: userNode.id, assistantMessageIds: targets.map((t) => t.assistantId) };
    } catch (err) {
      runs.finish(run, 'error');
      throw err;
    }
  }

  /** For a turn sent to the arena: the two models (in A/B order), else null. */
  private async arenaPick(user: AuthUser, req: CompletionRequest): Promise<{ models: [string, string] } | null> {
    if (!req.modelIds.includes(ARENA_MODEL_ID)) return null;
    if (req.regenerate) throw badRequest('Vote on this comparison first; then you can regenerate a reply.', 'arena_vote_first');
    if (req.modelIds.length > 1) throw badRequest('The arena picks its own two models: choose it alone.', 'arena_alone');
    const setting = await this.deps.settings.get('arena');
    const mine = new Set((await this.deps.models.forUser(user)).map((m) => m.id));
    const eligible = setting.models.filter((m) => mine.has(m));
    if (!setting.enabled || eligible.length < 2) throw badRequest('Blind comparisons are not available.', 'arena_off');
    const shuffled = [...eligible].sort(() => Math.random() - 0.5);
    return { models: [shuffled[0], shuffled[1]] };
  }

  private async execute(plan: RunPlan): Promise<void> {
    const { run, user, chat, req } = plan;
    const [userRow] = await this.deps.db.select({ settings: users.settings }).from(users).where(eq(users.id, user.id));
    const userSettings = (userRow?.settings as UserSettings | undefined) ?? {};
    // The user's preferences over the admin's defaults
    const prefs = { ...(await this.deps.settings.get('users.defaults')).preferences, ...userSettings.preferences };
    const vars: SystemValues = { userName: user.name };
    const sys = (content: string): ChatMessage => ({ role: 'system', content: fillSystemVariables(content, vars) });

    // System prompts, most general first: the diagram guidance, the user's,
    // the custom model's, memories, the skill, each folder's, the chat's
    const before: ChatMessage[] = [];
    if (prefs.visualExplanations !== false) before.push({ role: 'system', content: VISUAL_EXPLANATIONS_PROMPT });
    if (typeof prefs.systemPrompt === 'string' && prefs.systemPrompt.trim()) before.push(sys(prefs.systemPrompt));
    const after: ChatMessage[] = [];
    const userText = plan.userNode.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const folders = await this.folderChain(user, chat.folderId);
    const folderIds = folders.map((f) => f.id);
    // Temporary chats never write memory; the model gets memory tools only if an admin allows them
    const learns = !!this.deps.memories && !chat.temporary && MemoryLearner.learns(userSettings);
    const memoryTools = learns && (await this.deps.settings.get('memory')).tools;
    if (userSettings.memory?.enabled !== false && this.deps.memories) {
      const memory = await this.deps.memories.prompt(user.id, {
        folderIds,
        pick: (total) => this.relevantMemories(user.id, userText, total),
        withIds: memoryTools,
      });
      if (memory) after.push({ role: 'system', content: memory });
    }
    // Like the desktop: the skill follows the global prompt
    if (plan.skillPrompt) after.push({ role: 'system', content: plan.skillPrompt });
    for (const f of folders) {
      if (f.systemPrompt?.trim()) after.push(sys(f.systemPrompt));
    }
    if (chat.params.systemPrompt?.trim()) after.push(sys(chat.params.systemPrompt));
    // The writing style, apart from the system prompts
    if (plan.style) after.push({ role: 'system', content: stylePrompt(plan.style) });

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
    const { history, summary } = await this.compact(plan, [...before, ...after], fileOpts, prefs);

    const results = await Promise.all(
      plan.targets.map(async (t, i) => {
        const toolset = await toolsetFor(t.model);
        // GenAI semantic conventions; never the prompt or the reply
        const attributes = {
          'gen_ai.operation.name': 'chat',
          'gen_ai.provider.name': t.model.connection.type,
          'gen_ai.request.model': t.model.providerModelId,
          'claudia.model_id': t.model.model.id,
          'claudia.message_id': t.assistantId,
        };
        return withSpan(`chat ${t.model.providerModelId}`, attributes, () =>
          this.runModel(plan, t.assistantId, t.model, {
            system: [
              ...before,
              ...(t.model.custom?.systemPrompt.trim() ? [sys(t.model.custom.systemPrompt)] : []),
              ...after,
              ...(summary ? [compactionMessage(summary)] : []),
            ],
            history,
            prefs,
            memory: memoryTools ? { folderIds, sensitive: userSettings.memory?.sensitive === true } : null,
            toolset,
            fileOpts,
            reportTrim: i === 0,
            citations: sources.map((src) => ({ type: 'citation' as const, index: src.index, source: src.source })),
          })
        );
      })
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
    // Read the chat for memories once it has gone quiet
    const answered = plan.targets[results.indexOf('completed')];
    if (learns && answered && this.deps.memoryLearner) {
      await this.deps.memoryLearner
        .schedule(user.id, chat.id, answered.assistantId, this.deps.memoryIdleMs ?? 120_000)
        .catch((err) => this.deps.log.warn({ err: String(err), chatId: chat.id }, 'scheduling memory learning failed'));
    }
    await this.repo.touch(chat.id);
    this.deps.runs.finish(run, status);
    void this.deps.webhooks?.emit('run.completed', runSummary(plan, status));
  }

  /** Produce one assistant reply (with its tool loop) and persist it. */
  private async runModel(
    plan: RunPlan,
    assistantId: string,
    target: ResolvedModel,
    opts: {
      system: ChatMessage[];
      /** The path to send (after the summary, when there is one). */
      history: MessageNode[];
      prefs: Record<string, any>;
      /** The memory tools are offered (with what they need). */
      memory: { folderIds: string[]; sensitive: boolean } | null;
      toolset: RunToolset;
      fileOpts: ToOpenAIOptions;
      reportTrim: boolean;
      citations: Array<PartOf<'citation'>>;
    }
  ): Promise<RunStatus> {
    const { run, chat, req } = plan;
    const { runs, db, settings } = this.deps;
    const builder = new PartsBuilder();
    // Continuing: the reply keeps what it has (its citations too) and grows
    const continued = plan.continueNode?.id === assistantId ? plan.continueNode : null;
    for (const p of continued?.parts ?? []) builder.add(structuredClone(p));
    if (!continued) for (const c of opts.citations) builder.add(c);
    if (!continued && opts.citations.length > 0) {
      runs.emit(run, {
        type: 'message.citations',
        messageId: assistantId,
        citations: opts.citations.map((c) => ({ index: c.index, source: c.source })),
      });
    }
    const limits = await settings.get('limits');
    const signal = run.controller.signal;
    const started = Date.now();
    // The reply's total (both parts of a continued one); this run's own for the usage records
    let usage: MessageUsage | undefined = continued?.usage;
    let runUsage: MessageUsage | undefined;
    let status: RunStatus = 'completed';
    let error: string | undefined;
    let lastReason: string | undefined;

    // Request, then chat, then custom model, then the user's preferences
    const model = target.custom?.params ?? {};
    const effort: ReasoningEffort | undefined = coerceEffort(
      resolveEffort(req.params.effort ?? null, model.effort ?? null, opts.prefs.reasoningEffort ?? null),
      target.providerModelId
    );
    const temperature: number | undefined =
      req.params.temperature ?? chat.params.temperature ?? model.temperature ?? opts.prefs.temperature;
    const maxTokens = this.maxTokens(plan, target);
    const topP = chat.params.topP ?? model.topP;
    const frequencyPenalty = chat.params.frequencyPenalty ?? model.frequencyPenalty;
    const presencePenalty = chat.params.presencePenalty ?? model.presencePenalty;

    const budget = fitToContext({
      model: target.providerModelId,
      contextWindow: target.model.contextLength,
      outputReserve: this.outputReserve(plan, target, opts.prefs),
      system: opts.system,
      history: toOpenAIMessages(opts.history, opts.fileOpts),
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
          ...(final
            ? {
                status,
                error: error ?? null,
                usage: usage ?? null,
                // Cut off at the output limit: the reply can be continued
                meta: lastReason === 'length' && status === 'completed'
                  ? sql`${messages.meta} || '{"stopReason":"length"}'::jsonb`
                  : sql`${messages.meta} - 'stopReason'`,
              }
            : {}),
        })
        .where(eq(messages.id, assistantId));
    };
    const ticker = setInterval(() => void persist().catch(() => {}), PERSIST_INTERVAL_MS);

    try {
      const tools = [
        ...opts.toolset.definitions,
        ...(plan.codeEngine === 'browser' ? [CODE_TOOL] : plan.codeEngine === 'server' ? [RUN_CODE_TOOL] : []),
        ...(plan.imageGen ? [IMAGE_TOOL] : []),
        ...(opts.memory ? memoryToolDefinitions(!!chat.folderId) : []),
        ...(plan.pastChats ? CHAT_SEARCH_TOOLS : []),
      ];
      const isChatSearch = (name: string) => plan.pastChats && CHAT_SEARCH_TOOL_NAMES.has(name);
      const isMemoryTool = (name: string) => !!opts.memory && MEMORY_TOOL_NAMES.has(name);
      const onServer = (name: string) =>
        (plan.imageGen && name === IMAGE_TOOL_NAME) || isMemoryTool(name) || isServerCode(name) || isChatSearch(name);
      const inBrowser = (name: string) => plan.codeEngine === 'browser' && CLIENT_TOOL_NAMES.has(name);
      const isServerCode = (name: string) => plan.codeEngine === 'server' && name === RUN_CODE_TOOL_NAME;
      const firstTurnOnly = opts.toolset.firstTurnOnly || !!target.connection.quirks.toolsFirstTurnOnly;
      for (let iteration = 0; ; iteration++) {
        const offerTools = tools.length > 0 && (iteration === 0 || !firstTurnOnly);
        // The turn so far, expanded into assistant(tool_calls) → tool rounds
        const turnSoFar = toOpenAIMessages([
          { id: assistantId, chatId: chat.id, parentId: null, role: 'assistant', parts: builder.parts, status: 'streaming', createdAt: '' },
        ]).filter((m) => m.role !== 'assistant' || m.tool_calls);
        // Continuing, first request: the reply so far, then carry on from its last word
        const messagesNow =
          continued && iteration === 0
            ? continuationMessages(continued, target.connection.type === 'anthropic')
            : turnSoFar;

        const request: ChatCompletionRequest = {
          model: target.providerModelId,
          messages: [...budget.messages, ...messagesNow],
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
            runUsage = addUsage(runUsage, u);
            runs.emit(run, { type: 'message.usage', messageId: assistantId, usage });
          },
          onToolCalls: (calls) => {
            toolCalls = calls;
          },
        });

        lastReason = reason;
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
          const where = inBrowser(call.function.name)
            ? { serverId: 'browser', tool: call.function.name }
            : onServer(call.function.name)
              ? { serverId: 'claudia', tool: call.function.name }
              : opts.toolset.locate(call.function.name);
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
          const exec = await withSpan(
            `execute_tool ${call.function.name}`,
            { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': call.function.name, 'gen_ai.tool.call.id': call.id },
            async (span) => {
              const result = inBrowser(call.function.name)
                ? await this.runInBrowser(plan, assistantId, call, signal)
                : isChatSearch(call.function.name)
                  ? await this.searchChats(plan, assistantId, call, builder)
                : isServerCode(call.function.name)
                  ? await this.runServerCode(plan, assistantId, call, signal)
                  : isMemoryTool(call.function.name)
                  ? await this.memoryTool(plan, assistantId, call, opts.memory!)
                  : onServer(call.function.name)
                    ? await this.makeImage(plan, call, signal)
                    : await opts.toolset.execute(call, signal);
              span.setAttribute('claudia.tool.server', result.serverId);
              if (result.result.isError) span.setStatus({ code: SpanStatusCode.ERROR });
              return result;
            }
          );
          builder.add(exec.result);
          runs.emit(run, { type: 'tool.result', messageId: assistantId, part: exec.result });
          for (const part of exec.extraParts ?? []) {
            builder.add(part);
            runs.emit(run, { type: 'message.part', messageId: assistantId, part });
          }
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
    trace.getActiveSpan()?.setAttributes({
      'claudia.status': status,
      ...(usage ? { 'gen_ai.usage.input_tokens': usage.prompt_tokens ?? 0, 'gen_ai.usage.output_tokens': usage.completion_tokens ?? 0 } : {}),
    });
    if (status === 'error') trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR, message: error });
    runs.emit(run, {
      type: 'message.completed',
      messageId: assistantId,
      status,
      ...(error ? { error } : {}),
      ...(lastReason === 'length' && status === 'completed' ? { stopReason: 'length' as const } : {}),
      parts: builder.parts,
    });

    if (runUsage) {
      await db
        .insert(usageEvents)
        .values({
          id: uuidv7(),
          userId: plan.user.id,
          chatId: chat.id,
          modelId: target.model.id,
          connectionId: target.connection.id,
          kind: 'chat',
          promptTokens: runUsage.prompt_tokens ?? 0,
          completionTokens: runUsage.completion_tokens ?? 0,
          cost: runUsage.cost ?? null,
          latencyMs: Date.now() - started,
        })
        .catch((err) => this.deps.log.warn({ err: String(err) }, 'recording usage failed'));
    }
    return status;
  }

  /** The folders whose instructions and knowledge apply, top-down (shared ones too). */
  private folderChain(user: AuthUser, folderId: string | null) {
    return this.deps.folders ? this.deps.folders.chain(user, folderId) : this.repo.folderChain(user.id, folderId);
  }

  private maxTokens(plan: RunPlan, target: ResolvedModel): number | undefined {
    return plan.chat.params.maxTokens ?? target.custom?.params?.maxTokens;
  }

  private outputReserve(plan: RunPlan, target: ResolvedModel, prefs: Record<string, any>): number | undefined {
    return this.maxTokens(plan, target) ?? (typeof prefs.maxTokens === 'number' ? prefs.maxTokens : undefined);
  }

  /**
   * The history to send: after the deepest summary on the path, and, when it
   * nears the smallest context window of the models answering, with its
   * oldest turns folded into a new summary (stored on the last node it
   * covers, so later sends reuse it). If summarizing fails, the history is
   * sent as it is and the budget drops the oldest turns as before.
   */
  private async compact(
    plan: RunPlan,
    system: ChatMessage[],
    fileOpts: ToOpenAIOptions,
    prefs: Record<string, any>
  ): Promise<{ history: MessageNode[]; summary: string | null }> {
    const setting = await this.deps.settings.get('compaction');
    if (!setting.enabled) return { history: plan.history, summary: null };
    const { summary, rest } = latestCompaction(plan.history);
    const turns = nodeTurns(rest);
    if (turns.length === 0) return { history: rest, summary };

    const limit = Math.min(
      ...plan.targets.map(
        (t) =>
          promptLimit({ model: t.model.providerModelId, contextWindow: t.model.model.contextLength, outputReserve: this.outputReserve(plan, t.model, prefs) })
            .limit
      )
    );
    const fixed =
      estimateMessagesTokens(system) +
      estimateMessagesTokens(toOpenAIMessages([plan.userNode], fileOpts)) +
      (summary ? estimateMessagesTokens([compactionMessage(summary)]) : 0);
    const fold = planCompaction({
      limit,
      fixedTokens: fixed,
      turnTokens: turns.map((turn) => estimateMessagesTokens(toOpenAIMessages(turn, fileOpts))),
      threshold: setting.threshold,
      keepRecentTurns: setting.keepRecentTurns,
    });
    if (fold === 0) return { history: rest, summary };

    const folded = turns.slice(0, fold).flat();
    const boundary = folded[folded.length - 1];
    try {
      const fallback = plan.targets[0].model;
      // Like the task model, the summary model is the admin's choice
      const model = setting.model ? await this.deps.models.resolve(setting.model, 'admin').catch(() => fallback) : fallback;
      const window = promptLimit({ model: model.providerModelId, contextWindow: model.model.contextLength }).limit;
      const started = Date.now();
      const result = await summarize(model.provider, model.providerModelId, {
        previous: summary,
        nodes: folded,
        // About half the summarizer's window per call, in characters
        chunkChars: Math.floor(window / 2) * 4,
        signal: plan.run.controller.signal,
      });
      const priorTurns = plan.history.length > rest.length ? (plan.history[plan.history.length - rest.length - 1].compaction?.turns ?? 0) : 0;
      const compaction = { summary: result.summary, turns: priorTurns + fold, modelId: model.model.id, at: new Date().toISOString() };
      await this.deps.db
        .update(messages)
        .set({ meta: sql`${messages.meta} || ${JSON.stringify({ compaction })}::jsonb` })
        .where(eq(messages.id, boundary.id));
      await this.deps.db
        .insert(usageEvents)
        .values({
          id: uuidv7(),
          userId: plan.user.id,
          chatId: plan.chat.id,
          modelId: model.model.id,
          connectionId: model.connection.id,
          kind: 'compaction',
          promptTokens: result.usage.prompt_tokens ?? 0,
          completionTokens: result.usage.completion_tokens ?? 0,
          cost: result.usage.cost ?? null,
          latencyMs: Date.now() - started,
        })
        .catch((err) => this.deps.log.warn({ err: String(err) }, 'recording usage failed'));
      this.deps.runs.emit(plan.run, {
        type: 'run.notice',
        code: 'history_compacted',
        message: `The ${fold} oldest exchange${fold === 1 ? ' was' : 's were'} summarized to fit the model's context.`,
      });
      return { history: rest.slice(folded.length), summary: result.summary };
    } catch (err) {
      this.deps.log.warn({ err: String(err), chatId: plan.chat.id }, 'compaction failed; sending the history as it is');
      return { history: rest, summary };
    }
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

  /**
   * Search the user's earlier chats (only theirs, not temporary ones, and
   * inside a folder only that folder's). The chats found are added to the
   * reply's sources, numbered after the ones it has, so the model cites them
   * and the user can open them.
   */
  private async searchChats(plan: RunPlan, messageId: string, call: ToolCall, builder: PartsBuilder): Promise<ToolExecution> {
    const folderIds = plan.chat.folderId
      ? [plan.chat.folderId, ...((await this.deps.folders?.descendants(plan.chat.folderId)) ?? [])]
      : null;
    const cited = builder.parts.flatMap((p) => (p.type === 'citation' ? [p] : []));
    const next = cited.reduce((n, c) => Math.max(n, c.index), 0) + 1;
    try {
      const { content, isError, sources } = await runChatSearchTool(
        this.chatSearch,
        { userId: plan.user.id, excludeChatId: plan.chat.id, folderIds },
        call,
        next
      );
      if (sources.length) {
        for (const src of sources) builder.add({ type: 'citation', index: src.index, source: src.source });
        const all = builder.parts.flatMap((p) => (p.type === 'citation' ? [{ index: p.index, source: p.source }] : []));
        this.deps.runs.emit(plan.run, { type: 'message.citations', messageId, citations: all });
      }
      return { serverId: 'claudia', tool: call.function.name, result: { type: 'tool_result', callId: call.id, content, ...(isError ? { isError: true } : {}) } };
    } catch (err) {
      return {
        serverId: 'claudia',
        tool: call.function.name,
        result: { type: 'tool_result', callId: call.id, content: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), isError: true },
      };
    }
  }

  /** A memory tool call, as the user; a change shows as a chip under the reply. */
  private async memoryTool(
    plan: RunPlan,
    messageId: string,
    call: ToolCall,
    memory: { folderIds: string[]; sensitive: boolean }
  ): Promise<ToolExecution> {
    const { execution, change } = await runMemoryTool(
      this.deps.memories!,
      { userId: plan.user.id, chatId: plan.chat.id, folderId: plan.chat.folderId, folderIds: memory.folderIds, messageId, sensitive: memory.sensitive },
      call
    );
    if (change) this.deps.runs.emit(plan.run, { type: 'message.memory', messageId, change });
    return execution;
  }

  private async checkImageGen(user: AuthUser): Promise<void> {
    const engine = (await this.deps.media?.settings())?.image.engine ?? 'none';
    if (engine === 'none' || !this.deps.files) throw badRequest('Image generation is not set up on this server.', 'image_gen_off');
    if (this.deps.access) await this.deps.access.require(user, 'features.image_gen');
  }

  /** Generate images, keep them as the user's files and show them under the result. */
  private async makeImage(plan: RunPlan, call: ToolCall, signal: AbortSignal): Promise<ToolExecution> {
    const fail = (message: string): ToolExecution => ({
      serverId: 'claudia',
      tool: IMAGE_TOOL_NAME,
      result: { type: 'tool_result', callId: call.id, content: JSON.stringify({ error: message }), isError: true },
    });
    let args: { prompt?: unknown; size?: unknown };
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return fail('Invalid arguments: expected JSON with a "prompt".');
    }
    if (typeof args.prompt !== 'string' || !args.prompt.trim()) return fail('Give a "prompt" describing the image.');
    try {
      const media = this.deps.media!;
      const images = await generateImage((await media.settings()).image, await media.secret('imageKey'), args.prompt.slice(0, 4000), {
        size: typeof args.size === 'string' ? args.size : undefined,
        signal,
      });
      if (images.length === 0) return fail('The image service returned no image.');
      const parts: MessagePart[] = [];
      for (const [i, img] of images.entries()) {
        const ext = img.mime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
        const row = await this.deps.files!.ingest(plan.user.id, { name: `image-${Date.now()}${i ? `-${i}` : ''}.${ext}`, mime: img.mime, data: img.data });
        parts.push({ type: 'file', fileId: row.id, name: row.name, mime: row.mime, size: row.size });
      }
      return {
        serverId: 'claudia',
        tool: IMAGE_TOOL_NAME,
        result: {
          type: 'tool_result',
          callId: call.id,
          content: `Generated ${parts.length} image${parts.length === 1 ? '' : 's'} and showed ${parts.length === 1 ? 'it' : 'them'} to the user. Don't describe ${parts.length === 1 ? 'it' : 'them'} unless asked.`,
        },
        extraParts: parts,
      };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Where the code interpreter runs for this turn, or a refusal. */
  private async checkCode(user: AuthUser): Promise<'browser' | 'server'> {
    const { engine } = await this.deps.settings.get('code');
    const active = await activeCodeEngine(this.deps.settings, this.deps.sandboxOrigin, this.deps.code);
    if (!active) {
      throw badRequest(
        engine === 'off'
          ? 'The code interpreter is turned off.'
          : engine === 'server'
            ? 'Server-side code runs need a Docker daemon (CLAUDIA_CODE_DOCKER).'
            : 'The code interpreter needs a sandbox origin (CLAUDIA_SANDBOX_ORIGIN).',
        'code_unavailable'
      );
    }
    if (this.deps.access) await this.deps.access.require(user, 'features.code');
    return active;
  }

  /**
   * Run code in a server sandbox, with the turn's attachments in its working
   * folder. Printed output streams to the browser as it comes; files the code
   * writes are kept as the user's files and shown under the reply.
   */
  private async runServerCode(plan: RunPlan, messageId: string, call: ToolCall, signal: AbortSignal): Promise<ToolExecution> {
    const fail = (message: string): ToolExecution => ({
      serverId: 'claudia',
      tool: RUN_CODE_TOOL_NAME,
      result: { type: 'tool_result', callId: call.id, content: JSON.stringify({ error: message }), isError: true },
    });
    let args: { code?: unknown; language?: unknown };
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return fail('Invalid arguments: expected JSON with "code".');
    }
    if (typeof args.code !== 'string' || !args.code.trim()) return fail('Give the program to run as "code".');
    const language = args.language === 'node' ? 'node' : 'python';
    const { files, code, runs } = this.deps;
    if (!code || !files) return fail('Server-side code runs are not set up.');

    // The attachments of this chat's path, the user's own and readable
    const ids = [
      ...new Set([...plan.history, plan.userNode].flatMap((n) => n.parts.flatMap((p) => (p.type === 'file' && UUID.test(p.fileId) ? [p.fileId] : [])))),
    ];
    const inputs: Array<{ name: string; data: Buffer }> = [];
    for (const row of await files.ownedByIds(plan.user.id, ids)) {
      const data = await files.content(row).catch(() => null);
      if (data) inputs.push({ name: row.name, data });
    }

    // Printed output, a few times a second
    let pending = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pending) return;
      runs.emit(plan.run, { type: 'tool.output', messageId, callId: call.id, text: pending });
      pending = '';
    };
    try {
      const result = await code.run({
        language,
        code: args.code,
        files: inputs,
        signal,
        onOutput: (_stream, text) => {
          pending += text;
          if (!flushTimer) flushTimer = setTimeout(flush, 200);
        },
      });
      if (flushTimer) clearTimeout(flushTimer);
      flush();
      const extraParts: MessagePart[] = [];
      for (const f of result.files) {
        const row = await files.ingest(plan.user.id, { name: f.path.slice(0, 255), mime: workspaceMime(f.path), data: f.data });
        extraParts.push({ type: 'file', fileId: row.id, name: row.name, mime: row.mime, size: row.size });
      }
      const failed = result.timedOut || result.oomKilled || result.stopped || (result.exitCode ?? 0) !== 0;
      return {
        serverId: 'claudia',
        tool: RUN_CODE_TOOL_NAME,
        result: { type: 'tool_result', callId: call.id, content: codeRunSummary(result, result.files.map((f) => f.path)), ...(failed ? { isError: true } : {}) },
        ...(extraParts.length ? { extraParts } : {}),
      };
    } catch (err) {
      if (flushTimer) clearTimeout(flushTimer);
      return fail(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Ask the browser following the run to run a tool, and wait for its answer
   * (or the timeout, or the run being stopped).
   */
  private async runInBrowser(plan: RunPlan, messageId: string, call: ToolCall, signal: AbortSignal): Promise<ToolExecution> {
    const { runs } = this.deps;
    // Wait first, so even an instant answer finds the call
    const waiting = runs.awaitClientTool(plan.run, call.id, this.deps.clientToolTimeoutMs);
    runs.emit(plan.run, {
      type: 'tool.client_request',
      runId: plan.run.id,
      messageId,
      callId: call.id,
      name: call.function.name,
      args: call.function.arguments,
    });
    const stopped = new Promise<{ content: string; isError: boolean }>((resolve) =>
      signal.addEventListener('abort', () => resolve({ content: JSON.stringify({ error: 'Stopped.' }), isError: true }), { once: true })
    );
    const answer: ClientToolResult = await Promise.race([waiting, stopped]);
    const timedOut = answer.isError && answer.content.includes('No browser answered');
    // Files the code wrote: shown under the reply, if they are the user's own
    const extraParts: MessagePart[] = [];
    if (answer.fileIds?.length && this.deps.files) {
      const byId = new Map((await this.deps.files.ownedByIds(plan.user.id, answer.fileIds)).map((r) => [r.id, r]));
      for (const id of answer.fileIds) {
        const row = byId.get(id);
        if (row) extraParts.push({ type: 'file', fileId: row.id, name: row.name, mime: row.mime, size: row.size });
      }
    }
    return {
      serverId: 'browser',
      tool: call.function.name,
      result: {
        type: 'tool_result',
        callId: call.id,
        content: timedOut ? JSON.stringify({ error: NO_BROWSER_MESSAGE }) : answer.content,
        ...(answer.isError ? { isError: true } : {}),
      },
      ...(extraParts.length ? { extraParts } : {}),
    };
  }

  /** Refuse references the user can't use (before the run starts). */
  private async checkRefs(user: AuthUser, refs: MessageRef[], webSearch: boolean): Promise<void> {
    if (refs.length === 0 && !webSearch) return;
    const { access, sources, rag } = this.deps;
    if (!access || !sources || !rag) throw badRequest('References are not available here.', 'refs_unavailable');
    for (const r of refs) {
      if (r.type === 'chat') await this.repo.getOwned(user.id, r.id);
      if (r.type === 'note') {
        const [note] = await this.deps.db.select({ id: notes.id, ownerId: notes.ownerId }).from(notes).where(eq(notes.id, r.id));
        if (!note || !(await access.rights(user, 'note', note)).read) throw badRequest('A referenced note was not found.', 'note_not_found');
      }
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
    const chain = await this.folderChain(user, chat.folderId);
    const mine = [...refs.flatMap((r) => (r.type === 'kb' ? [r.id] : [])), ...chain.flatMap((f) => (f.userId === user.id ? (f.knowledgeIds ?? []) : []))];
    const kbIds = new Set(await readableKbIds(this.deps.db, mine, async (kb) => (await access.rights(user, 'knowledge', kb)).read));
    // A shared folder's knowledge: what its owner can read (or the user can)
    for (const f of chain) {
      if (f.userId === user.id || !f.knowledgeIds?.length) continue;
      const [owner] = await this.deps.db.select({ id: users.id, role: users.role }).from(users).where(eq(users.id, f.userId));
      const ok = await readableKbIds(
        this.deps.db,
        f.knowledgeIds,
        async (kb) => (await access.rights(user, 'knowledge', kb)).read || (!!owner && (await access.rights(owner, 'knowledge', kb)).read)
      );
      for (const id of ok) kbIds.add(id);
    }
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
    // Notes as they are now, if the user may still read them
    const noteRows = [];
    for (const r of refs) {
      if (r.type !== 'note') continue;
      const [note] = await this.deps.db.select().from(notes).where(eq(notes.id, r.id));
      if (note && (await access.rights(user, 'note', note)).read) noteRows.push({ id: note.id, title: note.title || 'Untitled note', content: note.content });
    }
    if (kbIds.size === 0 && urls.length === 0 && chatIds.length === 0 && noteRows.length === 0 && !plan.webSearch) return [];

    const built = await sources.build({ userId: user.id, query, kbIds: [...kbIds], urls, chatIds, notes: noteRows, webSearch: plan.webSearch });
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
