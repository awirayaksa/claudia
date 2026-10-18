import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChatInput, type ChatInputRef } from '@/components/chat/ChatInput';
import { SuggestedPrompts } from '@/components/chat/SuggestedPrompts';
import { useAppDispatch, useAppSelector } from '@/store';
import { setEffortLevel } from '@/store/slices/composerSlice';
import { loadSkills } from '@/store/slices/skillSlice';
import { parseEffortDirective } from '@/utils/effort-utils';
import type { MessageNode } from '@/types/turn.types';
import type { Attachment } from '@/types/message.types';
import type { Skill } from '@/types/skill.types';
import { resolveSkillCommand } from '@/utils/skill-utils';
import { ARENA_LABELS } from '@shared/arena';
import { CloudButton } from '../chat/CloudPicker';
import type { PromptView } from '@shared/workspace';
import { fillTemplate, templateVariables } from '@shared/prompts';
import {
  errorMessage,
  useChatQuery,
  useCreateChatMutation,
  useForkChatMutation,
  useMcpServersQuery,
  useArenaVoteMutation,
  useChatsQuery,
  useNotesQuery,
  useKnowledgeListQuery,
  useModelsQuery,
  usePermissions,
  usePromptsQuery,
  useRateMessageMutation,
  useSendCompletionMutation,
  useSessionQuery,
  useStopRunMutation,
  useUpdateChatMutation,
  useUpdateMySettingsMutation,
} from '../api/rtk-api';
import { useWebSelector } from '../hooks';
import { nodeText, visiblePath } from '../chat/to-display';
import { useResumeActiveRuns, useRunFollower } from '../chat/useRunFollower';
import { enabledServerIds } from '../chat/useMcpSync';
import { MessageTurns } from '../chat/MessageTurns';
import { ChatHeader } from '../chat/ChatHeader';
import { CloseIcon, CodeIcon, GlobeIcon, ImageIcon, PlusIcon } from '../components/icons';
import { PromptVariablesForm } from '../workspace/PromptForm';
import { ContextBar, hashMenuItems, refFromItem, sameRef, UrlDialog, urlRefsIn, type FeatureToggle } from '../chat/ContextBar';
import { useBrowserTools } from '../chat/browser-tools';
import { ArtifactPanel } from '../chat/ArtifactPanel';
import { MicButton } from '../chat/voice';
import type { Artifact } from '@/utils/artifacts';
import type { MessageRef } from '@shared/knowledge';

/** The model last picked by this user (per browser), for new chats. */
const LAST_MODEL_KEY = 'claudia.lastModel';
function readLastModel(): string | null {
  try {
    return localStorage.getItem(LAST_MODEL_KEY);
  } catch {
    return null;
  }
}

/** At most this many models answer at once. */
const MAX_MODELS = 4;

const UUID = /^[0-9a-f-]{36}$/i;

interface Outgoing {
  raw: string;
  attachments: Attachment[];
  refs?: MessageRef[];
  /** webSearch, code, imageGen */
  features?: Record<string, boolean>;
}

export function ChatPage() {
  const { t } = useTranslation();
  const { id: chatId } = useParams();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const inputRef = useRef<ChatInputRef>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: session } = useSessionQuery();
  const { data: modelsData, isLoading: modelsLoading } = useModelsQuery();
  const { data: chatData, error: chatError } = useChatQuery(chatId!, { skip: !chatId });
  const chat = chatId ? chatData?.chat : undefined;
  const live = useWebSelector((s) => (chatId ? s.runs[chatId] : undefined));
  const sessionEffort = useAppSelector((s) => s.composer.effortLevel);
  const skills = useAppSelector((s) => s.skills.skills);
  const { data: mcpData, refetch: refetchMcp } = useMcpServersQuery();
  const [arenaVote] = useArenaVoteMutation();
  const { data: promptData } = usePromptsQuery({ scope: 'usable' });
  const { data: kbData } = useKnowledgeListQuery();
  const { data: recentChats } = useChatsQuery();
  const { data: notesData } = useNotesQuery(undefined, { skip: !usePermissions()?.['features.notes'] });
  const permissions = usePermissions();
  /** References and web search for the next message. */
  const [refs, setRefs] = useState<MessageRef[]>([]);
  /** Web search, code interpreter and image generation for the next messages (until switched off). */
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [askUrl, setAskUrl] = useState(false);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const toggle = (id: string) => (on: boolean) => setFeatures((f) => ({ ...f, [id]: on }));
  const toggles: FeatureToggle[] = [
    ...(session?.features?.webSearch && permissions?.['features.web_search']
      ? [{ id: 'web-search', label: t('refs.webSearch'), help: t('refs.webSearchHelp'), on: !!features.webSearch, icon: <GlobeIcon />, onChange: toggle('webSearch') }]
      : []),
    ...(session?.features?.codeInterpreter && permissions?.['features.code']
      ? [{ id: 'code', label: t('tools.code'), help: t('tools.codeHelp'), on: !!features.code, icon: <CodeIcon />, onChange: toggle('code') }]
      : []),
    ...(session?.features?.imageGen && permissions?.['features.image_gen']
      ? [{ id: 'image', label: t('tools.image'), help: t('tools.imageHelp'), on: !!features.imageGen, icon: <ImageIcon />, onChange: toggle('imageGen') }]
      : []),
  ];
  const voice = permissions?.['features.voice'] ? session?.features : undefined;
  useBrowserTools(chatId);
  const addRef = (r: MessageRef) => setRefs((list) => (list.some((x) => sameRef(x, r)) ? list : [...list, r].slice(0, 10)));
  /** A prompt waiting for its {{variables}}, and where its text goes. */
  const [promptForm, setPromptForm] = useState<{ prompt: PromptView; insert: (text: string) => void } | null>(null);

  const [createChat] = useCreateChatMutation();
  const [sendCompletion] = useSendCompletionMutation();
  const [stopRun] = useStopRunMutation();
  const [updateChat] = useUpdateChatMutation();
  const [forkChat] = useForkChatMutation();
  const [rateMessage] = useRateMessageMutation();
  const [updateMySettings] = useUpdateMySettingsMutation();
  const { follow } = useRunFollower();
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  /** Models answering besides the selected one (side by side). */
  const [compare, setCompare] = useState<string[]>([]);
  /** Messages typed while a reply is still being written; sent in order. */
  const [queue, setQueue] = useState<Array<Outgoing & { id: number }>>([]);
  const [temporary, setTemporary] = useState(false);
  /** A send is on its way (its run isn't followed yet). */
  const sending = useRef(false);

  useResumeActiveRuns(chat?.id, chat?.activeRuns);

  const models = modelsData?.models ?? [];
  const modelIds = useMemo(() => models.map((m) => m.id), [models]);
  const modelName = (id?: string) =>
    !id ? undefined : id === ARENA_LABELS[0] ? t('arena.modelA') : id === ARENA_LABELS[1] ? t('arena.modelB') : (models.find((m) => m.id === id)?.name ?? id);
  const selectedModel = useMemo(() => {
    const candidates = [chat?.modelIds[0], pendingModel, readLastModel(), modelsData?.defaultModel];
    return candidates.find((m): m is string => !!m && modelIds.includes(m)) ?? modelIds[0] ?? '';
  }, [chat?.modelIds, pendingModel, modelsData?.defaultModel, modelIds]);
  const selectedInfo = models.find((m) => m.id === selectedModel);
  const sendModels = useMemo(
    () => [selectedModel, ...compare.filter((m) => m !== selectedModel && modelIds.includes(m))].filter(Boolean).slice(0, MAX_MODELS),
    [selectedModel, compare, modelIds]
  );

  // A new chat page starts clean; an existing chat brings back its comparison
  const loadedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    setSendError(null);
    setQueue([]);
    setRefs([]);
    setFeatures({});
    setArtifact(null);
    if (!chatId) {
      setCompare([]);
      setTemporary(false);
      loadedFor.current = undefined;
    }
  }, [chatId]);
  useEffect(() => {
    if (chat && loadedFor.current !== chat.id) {
      loadedFor.current = chat.id;
      setCompare(chat.modelIds.slice(1));
    }
  }, [chat]);

  // Stored nodes, with the live run's copies on top
  const nodes = useMemo(() => {
    const byId = new Map<string, MessageNode>((chat?.messages ?? []).map((n) => [n.id, n]));
    for (const n of Object.values(live?.nodes ?? {})) byId.set(n.id, n);
    return [...byId.values()];
  }, [chat?.messages, live?.nodes]);
  const running = !!live && !live.done;
  // Until the finished run's chat is refetched, its leaf is the run's
  const leafId = live?.leafId ?? chat?.currentLeafId ?? null;
  const path = useMemo(() => visiblePath(nodes, leafId), [nodes, leafId]);

  // Keep the newest message in view while it streams
  const lastText = path.length ? nodeText(path[path.length - 1]).length : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [path.length, lastText]);

  const handleModelChange = async (model: string) => {
    try {
      localStorage.setItem(LAST_MODEL_KEY, model);
    } catch {
      /* private mode */
    }
    void updateMySettings({ defaultModel: model });
    setCompare((c) => c.filter((m) => m !== model));
    if (chat) await updateChat({ id: chat.id, modelIds: [model, ...compare.filter((m) => m !== model)].slice(0, MAX_MODELS) });
    else setPendingModel(model);
  };

  const setCompareModels = (next: string[]) => {
    setCompare(next);
    if (chat && selectedModel) void updateChat({ id: chat.id, modelIds: [selectedModel, ...next].slice(0, MAX_MODELS) });
  };

  /** Send one message (new, edited or queued) after `parentId`. */
  const send = async (out: Outgoing, parentId: string | null) => {
    setSendError(null);
    const parsed = parseEffortDirective(out.raw);
    const { effort, directiveOnly } = parsed;
    // "/effort high" on its own sets the effort for the rest of the session
    if (directiveOnly) {
      dispatch(setEffortLevel(effort ?? null));
      return;
    }
    if (!selectedModel) return;
    // Right after the page opens, tool servers and skills may still be loading: wait for them
    const servers = mcpData?.servers ?? (await refetchMcp().unwrap().catch(() => null))?.servers;
    const knownSkills =
      parsed.content.startsWith('/') && skills.length === 0 ? await dispatch(loadSkills()).unwrap().catch(() => skills) : skills;
    // "/skill args": the server adds the skill's prompt; the chat shows the args
    const skillCall = resolveSkillCommand(parsed.content, knownSkills);
    const content = skillCall ? skillCall.userContent : parsed.content;
    const skill = skillCall ? { id: skillCall.skillId, args: parsed.content.replace(/^\/\S+/, '').trim() } : undefined;
    sending.current = true;
    try {
      let id = chatId;
      if (!id) {
        id = (await createChat({ modelIds: sendModels, ...(temporary ? { temporary: true } : {}) }).unwrap()).chat.id;
      }
      const res = await sendCompletion({
        chatId: id,
        parentId,
        content,
        modelIds: sendModels,
        params: { effort: effort !== undefined ? effort : (sessionEffort ?? undefined) },
        fileIds: out.attachments.map((a) => a.id).filter((x) => UUID.test(x)),
        toolIds: enabledServerIds(servers),
        ...(skill ? { skill } : {}),
        ...(out.refs?.length ? { refs: out.refs } : {}),
        ...(out.features && Object.values(out.features).some(Boolean) ? { features: out.features } : {}),
      }).unwrap();
      follow(id, res.runId);
      if (!chatId) navigate(`/c/${id}`);
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      sending.current = false;
    }
  };

  // The prompt library in the "/" menu, after the skills
  const prompts = useMemo(() => promptData?.prompts ?? [], [promptData]);
  const promptCommands = useMemo<Skill[]>(
    () =>
      prompts.map((p) => ({
        id: p.command,
        name: p.title,
        description: p.description ? `${p.title} — ${p.description}` : p.title,
        body: p.body,
        builtin: false,
        filePath: null,
      })),
    [prompts]
  );
  // The "#" menu: knowledge bases, a web page, recent chats (not this one)
  const hashItems = useMemo(
    () =>
      hashMenuItems(
        kbData?.knowledge ?? [],
        (recentChats?.chats ?? []).filter((c) => c.id !== chatId),
        { kb: t('refs.kb'), chat: t('refs.chat'), url: t('refs.webPage'), urlHelp: t('refs.webPageHelp'), note: t('refs.note') },
        notesData?.notes ?? []
      ),
    [kbData, recentChats, chatId, t, notesData]
  );
  // "Ask about this note" (from Notes) arrives as ?note=<id>&title=…
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('note');
    if (!id) return;
    addRef({ type: 'note', id, name: params.get('title') ?? undefined });
    window.history.replaceState(null, '', window.location.pathname);
    // Once, on arrival
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const openPrompt = (prompt: PromptView, insert: (text: string) => void) => {
    if (templateVariables(prompt.body).length > 0) setPromptForm({ prompt, insert });
    else insert(fillTemplate(prompt.body, {}, { userName: session?.user?.name, language: navigator.language }));
  };

  const handleSend = (raw: string, attachments: Attachment[] = []) => {
    // "/command" alone that names a prompt (and no skill) opens the prompt instead of sending
    const command = /^\/([a-z0-9][a-z0-9-]*)$/.exec(raw.trim())?.[1];
    const prompt = command && !skills.some((sk) => sk.id === command) ? prompts.find((p) => p.command === command) : undefined;
    if (prompt && attachments.length === 0) {
      openPrompt(prompt, (text) => inputRef.current?.setMessage(text));
      return;
    }
    // "#https://…" in the text reads that page too
    const typed = urlRefsIn(raw);
    const out: Outgoing = {
      raw: typed.text,
      attachments,
      refs: [...refs, ...typed.refs.filter((r) => !refs.some((x) => sameRef(x, r)))].slice(0, 10),
      features: Object.fromEntries(Object.entries(features).filter(([, on]) => on)),
    };
    setRefs([]);
    if (live || sending.current) {
      // A reply is still being written: send this one after it
      setQueue((q) => [...q, { id: Date.now() + Math.random(), ...out }]);
      return;
    }
    void send(out, chatId ? leafId : null);
  };

  // Next queued message once the run is over and the chat is up to date
  useEffect(() => {
    if (live || sending.current || queue.length === 0 || !chat) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    void send(next, chat.currentLeafId);
    // send is recreated every render; the queue and run state drive this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, queue, chat]);

  const handleStop = () => {
    if (live && !live.done) void stopRun(live.runId);
  };

  const regenerate = async (node: MessageNode) => {
    if (!chat || !node.parentId) return;
    setSendError(null);
    const model = node.modelId && modelIds.includes(node.modelId) ? node.modelId : selectedModel;
    try {
      const res = await sendCompletion({
        chatId: chat.id,
        parentId: node.parentId,
        regenerate: true,
        modelIds: [model],
        params: sessionEffort ? { effort: sessionEffort } : {},
        toolIds: enabledServerIds(mcpData?.servers),
      }).unwrap();
      follow(chat.id, res.runId);
    } catch (err) {
      setSendError(errorMessage(err));
    }
  };

  const editMessage = (node: MessageNode, text: string) => {
    const attachments = node.parts.flatMap((p) =>
      p.type === 'file' && p.fileId ? [{ id: p.fileId, type: 'file' as const, name: p.name, size: p.size ?? 0, mimeType: p.mime }] : []
    );
    // An edit keeps the turn's references and web search
    void send(
      { raw: text, attachments, refs: (node.refs ?? []) as MessageRef[], features: { ...(node.webSearch ? { webSearch: true } : {}) } },
      node.parentId
    );
  };

  const fork = async (node: MessageNode) => {
    if (!chat) return;
    try {
      const res = await forkChat({ id: chat.id, messageId: node.id }).unwrap();
      navigate(`/c/${res.chat.id}`);
    } catch (err) {
      setSendError(errorMessage(err));
    }
  };

  if (chatId && chatError) {
    return <div className="flex h-full items-center justify-center p-6 text-text-secondary">{t('chat.notFound')}</div>;
  }

  const noModels = !modelsLoading && modelIds.length === 0;
  const isEmpty = path.length === 0 && !running;

  return (
    <div className="flex h-full flex-col">
      <ChatHeader chat={chat} temporary={temporary} onTemporaryChange={setTemporary} />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="messages">
        <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-2 md:pt-6">
          {isEmpty ? (
            <div className="flex flex-col items-center pt-[10vh] text-center">
              <h1 className="mb-6 text-2xl font-semibold">{temporary ? t('chat.temporaryTitle') : t('chat.emptyTitle')}</h1>
              {temporary && <p className="mb-6 max-w-md text-sm text-text-secondary">{t('chat.temporaryHelp')}</p>}
              {selectedInfo?.description && <p className="mb-4 max-w-md text-sm text-text-secondary">{selectedInfo.description}</p>}
              {noModels ? (
                <p className="max-w-md text-text-secondary">
                  {t('chat.noModels')}{' '}
                  {session?.user?.role === 'admin' ? t('chat.noModelsAdmin') : t('chat.noModelsUser')}
                </p>
              ) : selectedInfo?.suggestions?.length ? (
                // A custom model's own starters
                <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-2" data-testid="model-suggestions">
                  {selectedInfo.suggestions.map((q) => (
                    <button
                      key={q}
                      className="rounded-lg border border-border px-3 py-2 text-left text-sm hover:border-accent hover:bg-surface"
                      onClick={() => inputRef.current?.setMessage(q)}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              ) : (
                selectedModel &&
                !temporary && <SuggestedPrompts model={selectedModel} onSelect={(prompt) => inputRef.current?.setMessage(prompt)} />
              )}
            </div>
          ) : (
            <MessageTurns
              nodes={nodes}
              path={path}
              running={running}
              modelName={modelName}
              onArenaVote={(turn, winner) => chat && void arenaVote({ chatId: chat.id, messageId: turn.id, winner })}
              onSelect={(id) => chat && void updateChat({ id: chat.id, currentLeafId: id })}
              onEdit={editMessage}
              onRegenerate={regenerate}
              onFork={fork}
              onRate={(node, rating, feedback) =>
                chat && void rateMessage({ chatId: chat.id, messageId: node.id, rating, ...feedback })
              }
              onFollowUp={(q) => handleSend(q)}
              onStop={handleStop}
              onArtifact={setArtifact}
              readAloud={voice?.readAloud ?? 'none'}
            />
          )}
          {live?.notices.map((n, i) => (
            <p key={i} className="my-2 rounded border border-border bg-surface px-3 py-2 text-xs text-text-secondary" role="status">
              {n}
            </p>
          ))}
          {sendError && (
            <p className="my-2 rounded border border-error/40 px-3 py-2 text-sm text-error" role="alert">
              {sendError}
            </p>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-2 pb-2 md:px-4 md:pb-4">
        {queue.length > 0 && (
          <ul className="mb-2 space-y-1" aria-label={t('chat.queued')} data-testid="queue">
            {queue.map((q) => (
              <li key={q.id} className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-1.5 text-sm">
                <span className="shrink-0 text-xs text-text-secondary">{t('chat.queuedLabel')}</span>
                <span className="min-w-0 flex-1 truncate">{q.raw || q.attachments.map((a) => a.name).join(', ')}</span>
                <button
                  className="rounded p-0.5 text-text-secondary hover:text-error"
                  aria-label={t('chat.unqueue')}
                  onClick={() => setQueue((list) => list.filter((x) => x.id !== q.id))}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        {modelIds.length > 1 && (
          <CompareModels
            selected={selectedModel}
            extra={compare.filter((m) => modelIds.includes(m) && m !== selectedModel)}
            available={models}
            disabled={running}
            onChange={setCompareModels}
          />
        )}
        <ContextBar refs={refs} onRemove={(r) => setRefs((list) => list.filter((x) => !sameRef(x, r)))} toggles={toggles} />
        <ChatInput
          ref={inputRef}
          onSend={handleSend}
          onAbort={handleStop}
          isGenerating={running}
          // Until a model is chosen (models still loading) a message would have nowhere to go
          disabled={noModels || !selectedModel}
          placeholder={t('chat.placeholder')}
          selectedModel={selectedModel}
          availableModels={modelIds}
          onModelChange={handleModelChange}
          modelLabel={(id) => modelName(id) ?? id}
          extraCommands={promptCommands}
          hashCommands={hashItems}
          toolbarExtras={
            <>
              <CloudButton
                disabled={noModels}
                onImported={(file) =>
                  inputRef.current?.addAttachments([
                    { id: file.id, type: file.mime.startsWith('image/') ? 'image' : 'file', name: file.name, size: file.size, mimeType: file.mime },
                  ])
                }
              />
              {voice && voice.voiceInput !== 'none' && (
                <MicButton mode={voice.voiceInput} disabled={noModels} onText={(text) => inputRef.current?.appendText(text)} />
              )}
            </>
          }
          hashEmptyLabel={t('refs.nothing')}
          onHashPick={(item) => {
            const r = refFromItem(item);
            if (r === 'ask-url') setAskUrl(true);
            else if (r) addRef(r);
          }}
          onCommandPick={(cmd, insert) => {
            const prompt = prompts.find((p) => p.command === cmd.id);
            if (prompt) openPrompt(prompt, insert);
          }}
        />
        {artifact && <ArtifactPanel artifact={artifact} onClose={() => setArtifact(null)} />}
        {askUrl && (
          <UrlDialog
            onClose={() => setAskUrl(false)}
            onAdd={(url) => {
              addRef({ type: 'url', url });
              setAskUrl(false);
              inputRef.current?.focus();
            }}
          />
        )}
        {promptForm && (
          <PromptVariablesForm
            prompt={promptForm.prompt}
            userName={session?.user?.name ?? ''}
            onClose={() => setPromptForm(null)}
            onInsert={(text) => {
              promptForm.insert(text);
              setPromptForm(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Extra models that answer next to the selected one. */
function CompareModels({
  selected,
  extra,
  available,
  disabled,
  onChange,
}: {
  selected: string;
  extra: string[];
  available: Array<{ id: string; name: string }>;
  disabled: boolean;
  onChange: (models: string[]) => void;
}) {
  const { t } = useTranslation();
  const [picking, setPicking] = useState(false);
  const options = available.filter((m) => m.id !== selected && !extra.includes(m.id));
  const name = (id: string) => available.find((m) => m.id === id)?.name ?? id;
  if (extra.length === 0 && !picking) {
    return (
      <div className="mb-1.5 flex justify-end">
        <button
          className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-text-secondary hover:text-accent disabled:opacity-50"
          disabled={disabled}
          onClick={() => setPicking(true)}
        >
          <PlusIcon />
          {t('chat.compare')}
        </button>
      </div>
    );
  }
  return (
    <div className="mb-1.5 flex flex-wrap items-center justify-end gap-1.5 text-xs" data-testid="compare-models">
      <span className="text-text-secondary">{t('chat.alsoAsk')}</span>
      {extra.map((m) => (
        <span key={m} className="flex items-center gap-1 rounded-full border border-border py-0.5 pl-2.5 pr-1">
          {name(m)}
          <button
            className="rounded-full p-0.5 text-text-secondary hover:text-error disabled:opacity-50"
            aria-label={t('chat.removeModel', { name: name(m) })}
            disabled={disabled}
            onClick={() => onChange(extra.filter((x) => x !== m))}
          >
            <CloseIcon />
          </button>
        </span>
      ))}
      {extra.length < MAX_MODELS - 1 && options.length > 0 && (
        <select
          className="rounded border border-border bg-background px-1.5 py-0.5"
          aria-label={t('chat.addModel')}
          value=""
          disabled={disabled}
          onChange={(e) => {
            if (e.target.value) onChange([...extra, e.target.value]);
            setPicking(false);
          }}
        >
          <option value="">{t('chat.addModel')}</option>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
