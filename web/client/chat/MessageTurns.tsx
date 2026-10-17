/**
 * The visible path of a chat, with what Phase 2 adds on top of the shared
 * message components: versions of a message (`< 2/3 >`), editing a message
 * into a new version, regenerating, forking, ratings with feedback, answers
 * of several models side by side, and follow-up suggestions.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { StreamingMessage } from '@/components/chat/StreamingMessage';
import type { MessageNode } from '@/types/turn.types';
import { nodeText, toDisplayMessage } from './to-display';
import { leafUnder, modelColumns, siblingsOf, type ModelColumn } from './tree';
import { VersionSwitcher } from './VersionSwitcher';

export interface TurnHandlers {
  /** Show the path through this node (a version switch). */
  onSelect?: (nodeId: string) => void;
  /** Send an edited copy of a user message (a new version of it). */
  onEdit?: (node: MessageNode, text: string) => void;
  onRegenerate?: (node: MessageNode) => void;
  onFork?: (node: MessageNode) => void;
  onRate?: (node: MessageNode, rating: 1 | -1 | null, feedback?: { comment?: string; reasons?: string[] }) => void;
  onFollowUp?: (text: string) => void;
  onStop?: () => void;
}

interface Props extends TurnHandlers {
  nodes: MessageNode[];
  path: MessageNode[];
  running: boolean;
  modelName: (id?: string) => string | undefined;
  /** Share links: no actions at all. */
  readOnly?: boolean;
}

const FEEDBACK_REASONS = ['inaccurate', 'unhelpful', 'instructions', 'too_long', 'unsafe'] as const;

export function MessageTurns(props: Props) {
  const { nodes, path, running, readOnly } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const last = path[path.length - 1];

  return (
    <>
      {path.map((node, i) => {
        if (node.role === 'user') {
          if (editingId === node.id) {
            return (
              <EditMessage
                key={node.id}
                initial={nodeText(node, 'text', '')}
                onCancel={() => setEditingId(null)}
                onSave={(text) => {
                  setEditingId(null);
                  props.onEdit?.(node, text);
                }}
              />
            );
          }
          return (
            <UserTurn
              key={node.id}
              node={node}
              nodes={nodes}
              disabled={running}
              readOnly={readOnly}
              onSelect={props.onSelect}
              onEdit={props.onEdit ? () => setEditingId(node.id) : undefined}
            />
          );
        }

        const parent = path[i - 1];
        const columns = parent?.role === 'user' ? modelColumns(nodes, parent) : null;
        const reply = columns ? (
          <ModelColumns key={node.id} {...props} columns={columns} activeId={node.id} onFeedback={setFeedbackFor} />
        ) : (
          <AssistantTurn key={node.id} {...props} node={node} onFeedback={setFeedbackFor} />
        );
        return (
          <div key={node.id}>
            {reply}
            {feedbackFor && nodes.find((n) => n.id === feedbackFor)?.parentId === node.parentId && (
              <FeedbackForm
                onCancel={() => setFeedbackFor(null)}
                onSend={(feedback) => {
                  const target = nodes.find((n) => n.id === feedbackFor);
                  setFeedbackFor(null);
                  if (target) props.onRate?.(target, -1, feedback);
                }}
              />
            )}
          </div>
        );
      })}
      {!readOnly && !running && last?.role === 'assistant' && last.status === 'completed' && last.followUps?.length ? (
        <FollowUps items={last.followUps} onPick={(q) => props.onFollowUp?.(q)} />
      ) : null}
    </>
  );
}

function UserTurn({
  node,
  nodes,
  disabled,
  readOnly,
  onSelect,
  onEdit,
}: {
  node: MessageNode;
  nodes: MessageNode[];
  disabled: boolean;
  readOnly?: boolean;
  onSelect?: (id: string) => void;
  onEdit?: () => void;
}) {
  const versions = siblingsOf(nodes, node);
  const index = versions.findIndex((v) => v.id === node.id);
  return (
    <>
      <ChatMessage
        message={toDisplayMessage(node)}
        disabled={disabled}
        onEdit={!readOnly && onEdit ? () => onEdit() : undefined}
        actions={
          <VersionSwitcher
            index={index}
            count={versions.length}
            disabled={disabled}
            onChange={(i) => onSelect?.(leafUnder(nodes, versions[i].id))}
          />
        }
      />
      <RefChips node={node} />
    </>
  );
}

/** What a message referenced (#kb, #url, #chat) and whether it searched the web. */
function RefChips({ node }: { node: MessageNode }) {
  const { t } = useTranslation();
  if (!node.refs?.length && !node.webSearch) return null;
  const label = (r: NonNullable<MessageNode['refs']>[number]) =>
    r.type === 'url' ? (r.url ?? '').replace(/^https?:\/\//, '') : (r.name ?? t(`refs.${r.type}`));
  return (
    <div className="-mt-2 mb-4 flex flex-wrap justify-end gap-1.5 text-xs" data-testid="message-refs">
      {node.refs?.map((r, i) => (
        <span key={i} className="max-w-[16rem] truncate rounded-full border border-border px-2 py-0.5 text-text-secondary" title={r.url ?? r.name}>
          <span className="mr-1 text-accent">#</span>
          {label(r)}
        </span>
      ))}
      {node.webSearch && <span className="rounded-full border border-border px-2 py-0.5 text-text-secondary">{t('refs.webSearched')}</span>}
    </div>
  );
}

function AssistantTurn(
  props: Props & { node: MessageNode; authorLabel?: string; versions?: MessageNode[]; onFeedback: (id: string) => void; onVersion?: (id: string) => void }
) {
  const { node, nodes, running, readOnly } = props;
  const navigate = useNavigate();
  if (node.status === 'streaming') {
    return <StreamingMessage content={nodeText(node)} reasoning={nodeText(node, 'reasoning', '')} onAbort={props.onStop} />;
  }
  const versions = props.versions ?? siblingsOf(nodes, node);
  const index = versions.findIndex((v) => v.id === node.id);
  const select = props.onVersion ?? ((id: string) => props.onSelect?.(leafUnder(nodes, id)));
  return (
    <ChatMessage
      message={toDisplayMessage(node)}
      authorLabel={props.authorLabel}
      onOpenSource={readOnly ? undefined : (src) => src.kind === 'chat' && src.id && navigate(`/c/${src.id}`)}
      disabled={running}
      onRetry={!readOnly && props.onRegenerate ? () => props.onRegenerate!(node) : undefined}
      onBranch={!readOnly && props.onFork ? () => props.onFork!(node) : undefined}
      rating={node.rating}
      hideRatings={readOnly}
      onRate={
        !readOnly && props.onRate
          ? (rating) => {
              props.onRate!(node, rating);
              if (rating === -1) props.onFeedback(node.id);
            }
          : undefined
      }
      actions={<VersionSwitcher index={index} count={versions.length} disabled={running} onChange={(i) => select(versions[i].id)} />}
    />
  );
}

/** Several models' answers to one turn, side by side (stacked on phones). */
function ModelColumns(props: Props & { columns: ModelColumn[]; activeId: string; onFeedback: (id: string) => void }) {
  const { t } = useTranslation();
  const { columns, activeId, nodes, readOnly } = props;
  // Inactive columns can browse their own versions without changing the path
  const [shown, setShown] = useState<Record<string, string>>({});

  return (
    <div className="-mx-4 overflow-x-auto px-4 py-2" data-testid="model-columns">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(260px, 1fr))` }}>
        {columns.map((col) => {
          const onPath = col.versions.find((v) => v.id === activeId);
          const current = onPath ?? col.versions.find((v) => v.id === shown[col.modelId]) ?? col.versions[col.versions.length - 1];
          const active = !!onPath;
          return (
            <section
              key={col.modelId}
              className={`min-w-0 rounded-lg border px-3 ${active ? 'border-accent/60 bg-surface/40' : 'border-border'}`}
              aria-label={props.modelName(col.modelId) ?? col.modelId}
              data-active={active}
            >
              <AssistantTurn
                {...props}
                node={current}
                authorLabel={props.modelName(col.modelId) ?? col.modelId}
                versions={col.versions}
                onVersion={(id) => (active ? props.onSelect?.(leafUnder(nodes, id)) : setShown((s) => ({ ...s, [col.modelId]: id })))}
              />
              {!active && !readOnly && current.status !== 'streaming' && (
                <button
                  className="mb-3 text-xs text-accent hover:underline"
                  onClick={() => props.onSelect?.(leafUnder(nodes, current.id))}
                >
                  {t('chat.continueWith')}
                </button>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function EditMessage({ initial, onSave, onCancel }: { initial: string; onSave: (text: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, []);
  return (
    <div className="flex justify-end py-2">
      <div className="w-full max-w-[85%] rounded-xl border border-border bg-background p-2">
        <textarea
          ref={ref}
          className="w-full resize-none bg-transparent p-1 text-sm outline-none"
          value={text}
          aria-label={t('chat.editMessage')}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 320)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel();
            else if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
              e.preventDefault();
              onSave(text.trim());
            }
          }}
        />
        <div className="flex justify-end gap-2 pt-1">
          <button className="rounded px-3 py-1 text-sm text-text-secondary hover:bg-surface" onClick={onCancel}>
            {t('app.cancel')}
          </button>
          <button
            className="rounded bg-accent px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={!text.trim()}
            onClick={() => onSave(text.trim())}
          >
            {t('chat.saveAndSend')}
          </button>
        </div>
      </div>
    </div>
  );
}

function FeedbackForm({ onSend, onCancel }: { onSend: (f: { comment?: string; reasons?: string[] }) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [reasons, setReasons] = useState<string[]>([]);
  const [comment, setComment] = useState('');
  return (
    <form
      className="mb-3 ml-[30px] rounded-lg border border-border bg-surface p-3 text-sm"
      aria-label={t('chat.feedbackTitle')}
      onSubmit={(e) => {
        e.preventDefault();
        onSend({ ...(comment.trim() ? { comment: comment.trim() } : {}), ...(reasons.length ? { reasons } : {}) });
      }}
    >
      <p className="mb-2 font-medium">{t('chat.feedbackTitle')}</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {FEEDBACK_REASONS.map((r) => {
          const on = reasons.includes(r);
          return (
            <button
              key={r}
              type="button"
              aria-pressed={on}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? 'border-accent text-accent' : 'border-border text-text-secondary hover:border-accent'}`}
              onClick={() => setReasons((list) => (on ? list.filter((x) => x !== r) : [...list, r]))}
            >
              {t(`chat.feedbackReasons.${r}`)}
            </button>
          );
        })}
      </div>
      <textarea
        className="mb-2 w-full rounded border border-border bg-background p-2 text-sm outline-none focus:border-accent"
        rows={2}
        maxLength={2000}
        placeholder={t('chat.feedbackComment')}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded px-3 py-1 text-text-secondary hover:bg-background" onClick={onCancel}>
          {t('app.cancel')}
        </button>
        <button type="submit" className="rounded bg-accent px-3 py-1 text-white">
          {t('chat.feedbackSend')}
        </button>
      </div>
    </form>
  );
}

function FollowUps({ items, onPick }: { items: string[]; onPick: (q: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="mb-2 ml-[30px] mt-1" data-testid="follow-ups">
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-secondary">{t('chat.followUps')}</p>
      <div className="flex flex-col items-start gap-1.5">
        {items.map((q) => (
          <button
            key={q}
            className="rounded-lg border border-border px-3 py-1.5 text-left text-sm hover:border-accent hover:text-accent"
            onClick={() => onPick(q)}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
