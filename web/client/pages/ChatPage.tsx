import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChatInput, type ChatInputRef } from '@/components/chat/ChatInput';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { StreamingMessage } from '@/components/chat/StreamingMessage';
import { SuggestedPrompts } from '@/components/chat/SuggestedPrompts';
import { useAppDispatch, useAppSelector } from '@/store';
import { setEffortLevel } from '@/store/slices/composerSlice';
import { parseEffortDirective } from '@/utils/effort-utils';
import type { MessageNode } from '@/types/turn.types';
import type { Attachment } from '@/types/message.types';
import { resolveSkillCommand } from '@/utils/skill-utils';
import {
  errorMessage,
  useChatQuery,
  useCreateChatMutation,
  useMcpServersQuery,
  useModelsQuery,
  useSendCompletionMutation,
  useSessionQuery,
  useStopRunMutation,
  useUpdateChatMutation,
  useUpdateMySettingsMutation,
} from '../api/rtk-api';
import { useWebSelector } from '../hooks';
import { nodeText, toDisplayMessage, visiblePath } from '../chat/to-display';
import { useResumeActiveRuns, useRunFollower } from '../chat/useRunFollower';
import { enabledServerIds } from '../chat/useMcpSync';

/** The model last picked by this user (per browser), for new chats. */
const LAST_MODEL_KEY = 'claudia.lastModel';
function readLastModel(): string | null {
  try {
    return localStorage.getItem(LAST_MODEL_KEY);
  } catch {
    return null;
  }
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
  const { data: mcpData } = useMcpServersQuery();

  const [createChat] = useCreateChatMutation();
  const [sendCompletion] = useSendCompletionMutation();
  const [stopRun] = useStopRunMutation();
  const [updateChat] = useUpdateChatMutation();
  const [updateMySettings] = useUpdateMySettingsMutation();
  const { follow } = useRunFollower();
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);

  useResumeActiveRuns(chat?.id, chat?.activeRuns);

  const modelIds = useMemo(() => (modelsData?.models ?? []).map((m) => m.id), [modelsData]);
  const selectedModel = useMemo(() => {
    const candidates = [chat?.modelIds[0], pendingModel, readLastModel(), modelsData?.defaultModel];
    return candidates.find((m): m is string => !!m && modelIds.includes(m)) ?? modelIds[0] ?? '';
  }, [chat?.modelIds, pendingModel, modelsData?.defaultModel, modelIds]);

  // Stored nodes, with the live run's copies on top
  const nodes = useMemo(() => {
    const byId = new Map<string, MessageNode>((chat?.messages ?? []).map((n) => [n.id, n]));
    for (const n of Object.values(live?.nodes ?? {})) byId.set(n.id, n);
    return [...byId.values()];
  }, [chat?.messages, live?.nodes]);
  const running = !!live && !live.done;
  const leafId = running && live?.leafId ? live.leafId : (chat?.currentLeafId ?? null);
  const path = useMemo(() => visiblePath(nodes, leafId), [nodes, leafId]);

  // Keep the newest message in view while it streams
  const lastText = path.length ? nodeText(path[path.length - 1]).length : 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
  }, [path.length, lastText]);

  useEffect(() => setSendError(null), [chatId]);

  const handleModelChange = async (model: string) => {
    try {
      localStorage.setItem(LAST_MODEL_KEY, model);
    } catch {
      /* private mode */
    }
    void updateMySettings({ defaultModel: model });
    if (chat) await updateChat({ id: chat.id, modelIds: [model] });
    else setPendingModel(model);
  };

  const handleSend = async (raw: string, attachments: Attachment[] = []) => {
    setSendError(null);
    const parsed = parseEffortDirective(raw);
    const { effort, directiveOnly } = parsed;
    // "/effort high" on its own sets the effort for the rest of the session
    if (directiveOnly) {
      dispatch(setEffortLevel(effort ?? null));
      return;
    }
    if (!selectedModel) return;
    // "/skill args": the server adds the skill's prompt; the chat shows the args
    const skillCall = resolveSkillCommand(parsed.content, skills);
    const content = skillCall ? skillCall.userContent : parsed.content;
    const skill = skillCall ? { id: skillCall.skillId, args: parsed.content.replace(/^\/\S+/, '').trim() } : undefined;
    try {
      let id = chatId;
      if (!id) {
        id = (await createChat({ modelIds: [selectedModel] }).unwrap()).chat.id;
      }
      const res = await sendCompletion({
        chatId: id,
        parentId: chatId ? leafId : null,
        content,
        modelIds: [selectedModel],
        params: { effort: effort !== undefined ? effort : (sessionEffort ?? undefined) },
        fileIds: attachments.map((a) => a.id),
        toolIds: enabledServerIds(mcpData?.servers),
        ...(skill ? { skill } : {}),
      }).unwrap();
      follow(id, res.runId);
      if (!chatId) navigate(`/c/${id}`);
    } catch (err) {
      setSendError(errorMessage(err));
    }
  };

  const handleStop = () => {
    if (live && !live.done) void stopRun(live.runId);
  };

  if (chatId && chatError) {
    return <div className="flex h-full items-center justify-center p-6 text-text-secondary">{t('chat.notFound')}</div>;
  }

  const noModels = !modelsLoading && modelIds.length === 0;
  const isEmpty = path.length === 0 && !running;

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="messages">
        <div className="mx-auto w-full max-w-3xl px-4 pb-6 pt-4 md:pt-10">
          {isEmpty ? (
            <div className="flex flex-col items-center pt-[12vh] text-center">
              <h1 className="mb-6 text-2xl font-semibold">{t('chat.emptyTitle')}</h1>
              {noModels ? (
                <p className="max-w-md text-text-secondary">
                  {t('chat.noModels')}{' '}
                  {session?.user?.role === 'admin' ? t('chat.noModelsAdmin') : t('chat.noModelsUser')}
                </p>
              ) : (
                selectedModel && (
                  <SuggestedPrompts model={selectedModel} onSelect={(prompt) => inputRef.current?.setMessage(prompt)} />
                )
              )}
            </div>
          ) : (
            path.map((node) =>
              node.role === 'assistant' && node.status === 'streaming' ? (
                <StreamingMessage
                  key={node.id}
                  content={nodeText(node)}
                  reasoning={nodeText(node, 'reasoning', '')}
                  onAbort={handleStop}
                />
              ) : (
                <ChatMessage key={node.id} message={toDisplayMessage(node)} />
              )
            )
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
        <ChatInput
          ref={inputRef}
          onSend={handleSend}
          onAbort={handleStop}
          isGenerating={running}
          disabled={noModels}
          placeholder={t('chat.placeholder')}
          selectedModel={selectedModel}
          availableModels={modelIds}
          onModelChange={handleModelChange}
        />
      </div>
    </div>
  );
}
