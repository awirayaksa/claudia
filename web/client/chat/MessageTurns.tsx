/**
 * The visible path of a chat, with what Phase 2 adds on top of the shared
 * message components: versions of a message (`< 2/3 >`), editing a message
 * into a new version, regenerating, forking, ratings with feedback, answers
 * of several models side by side, and follow-up suggestions.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { StreamingMessage } from '@/components/chat/StreamingMessage';
import type { MessageNode } from '@/types/turn.types';
import { nodeText, toDisplayMessage } from './to-display';
import { leafUnder, modelColumns, siblingsOf, type ModelColumn } from './tree';
import { VersionSwitcher } from './VersionSwitcher';
import { findArtifacts, type Artifact } from '@/utils/artifacts';
import { ReadAloudButton } from './voice';

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
  /** Show a reply's HTML/SVG/React code live. */
  onArtifact?: (artifact: Artifact) => void;
  /** How replies are read aloud (none: no button). */
  readAloud?: 'none' | 'browser' | 'server';
  /** A blind comparison's vote. */
  onArenaVote?: (turn: MessageNode, winner: 'a' | 'b' | 'tie') => void;
  /** Undo a memory the model saved, changed or forgot (none: the chip only shows them). */
  onUndoMemory?: (change: MemoryChange) => void;
}

type MemoryChange = NonNullable<MessageNode['memoryChanges']>[number];

interface Props extends TurnHandlers {
  nodes: MessageNode[];
  path: MessageNode[];
  running: boolean;
  modelName: (id?: string) => string | undefined;
  /** Share links: no actions at all. */
  readOnly?: boolean;
  /** What running tools printed so far, by call id (live runs). */
  toolOutput?: Record<string, string>;
}

const FEEDBACK_REASONS = ['inaccurate', 'unhelpful', 'instructions', 'too_long', 'unsafe'] as const;

export function MessageTurns(props: Props) {
  const { nodes, path, running, readOnly } = props;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const last = path[path.length - 1];

  const renderNode = (node: MessageNode, i: number): ReactNode => {
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
      <>
        <ModelColumns key={node.id} {...props} columns={columns} activeId={node.id} onFeedback={setFeedbackFor} />
        {parent.arena && <ArenaVote turn={parent} replies={columns.flatMap((c) => c.versions)} onVote={props.readOnly ? undefined : props.onArenaVote} />}
      </>
    ) : (
      <AssistantTurn key={node.id} {...props} node={node} onFeedback={setFeedbackFor} />
    );
    return (
      <div key={node.id}>
        {reply}
        {!readOnly && node.memoryChanges?.length ? <MemoryChip changes={node.memoryChanges} onUndo={props.onUndoMemory} /> : null}
        {props.onArtifact && node.status !== 'streaming' && <ArtifactChips node={node} onOpen={props.onArtifact} />}
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
  };

  return (
    <>
      {path.map((node, i) => (
        <Fragment key={node.id}>
          {renderNode(node, i)}
          {node.compaction && <CompactionDivider summary={node.compaction.summary} turns={node.compaction.turns} />}
        </Fragment>
      ))}
      {!readOnly && !running && last?.role === 'assistant' && last.status === 'completed' && last.followUps?.length ? (
        <FollowUps items={last.followUps} onPick={(q) => props.onFollowUp?.(q)} />
      ) : null}
    </>
  );
}

/** While a reply is being written: its tool calls, which are still running, and what they print. */
function LiveTools({ node, output }: { node: MessageNode; output?: Record<string, string> }) {
  const { t } = useTranslation();
  const calls = node.parts.filter((p) => p.type === 'tool_call');
  if (calls.length === 0) return null;
  const done = new Set(node.parts.flatMap((p) => (p.type === 'tool_result' ? [p.callId] : [])));
  return (
    <ul className="mb-3 space-y-1.5 ps-[30px] text-xs" data-testid="live-tools">
      {calls.map((c) => {
        const printed = output?.[c.callId];
        const running = !done.has(c.callId);
        return (
          <li key={c.callId} className="rounded-lg border border-border bg-surface">
            <div className="flex items-center gap-2 px-3 py-1.5 text-text-secondary">
              <span className={running ? 'animate-pulse text-accent' : 'text-success'} aria-hidden>
                ●
              </span>
              <span className="font-mono">{c.tool || c.alias}</span>
              <span>{running ? t('tools.running') : t('tools.done')}</span>
            </div>
            {running && printed && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border px-3 py-2 font-mono text-[11px]" data-testid="live-tool-output">
                {printed.split('\n').slice(-40).join('\n')}
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** "Memory updated" under a reply: opens to list what changed, each undoable. */
function MemoryChip({ changes, onUndo }: { changes: MemoryChange[]; onUndo?: (c: MemoryChange) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const live = changes.filter((c) => !c.undone).length;
  return (
    <div className="-mt-1 mb-4 ps-[30px] text-xs" data-testid="memory-chip">
      <button
        className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-text-secondary hover:border-accent hover:text-accent"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden>✦</span>
        {live > 0 ? t('memory.chip', { count: live }) : t('memory.chipUndone')}
      </button>
      {open && (
        <ul className="mt-2 max-w-xl divide-y divide-border rounded-lg border border-border bg-surface">
          {changes.map((c) => (
            <li key={c.id} className="flex items-start gap-2 px-3 py-2">
              <span className="shrink-0 text-text-secondary">{t(`memory.changed.${c.action}`)}</span>
              <span className={`min-w-0 flex-1 break-words ${c.undone ? 'text-text-secondary line-through' : ''}`}>{c.content}</span>
              {c.undone ? (
                <span className="shrink-0 text-text-secondary">{t('memory.undone')}</span>
              ) : (
                onUndo && (
                  <button className="shrink-0 text-accent hover:underline" onClick={() => onUndo(c)}>
                    {t('memory.undo')}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where earlier turns were summarized to fit the context window; opens to show the summary. */
function CompactionDivider({ summary, turns }: { summary: string; turns: number }) {
  const { t } = useTranslation();
  return (
    <details className="group my-4 text-xs text-text-secondary" data-testid="compaction-divider">
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <span className="h-px flex-1 bg-border" />
        <span className="rounded-full border border-border px-2.5 py-0.5 hover:border-accent hover:text-accent">
          {t('chat.compacted', { count: turns })}
        </span>
        <span className="h-px flex-1 bg-border" />
      </summary>
      <div className="mt-2 rounded-lg border border-border bg-surface p-3 text-sm text-text-primary">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-text-secondary">{t('chat.compactedSummary')}</p>
        <p className="whitespace-pre-wrap">{summary}</p>
      </div>
    </details>
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
          <span className="me-1 text-accent">#</span>
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
    return (
      <>
        <StreamingMessage content={nodeText(node)} reasoning={nodeText(node, 'reasoning', '')} onAbort={props.onStop} />
        <LiveTools node={node} output={props.toolOutput} />
      </>
    );
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
      actions={
        <>
          <VersionSwitcher index={index} count={versions.length} disabled={running} onChange={(i) => select(versions[i].id)} />
          {!readOnly && props.readAloud && props.readAloud !== 'none' && <ReadAloudButton mode={props.readAloud} text={nodeText(node)} />}
        </>
      }
    />
  );
}

/** "Preview" chips for a reply's complete HTML, SVG and React blocks. */
function ArtifactChips({ node, onOpen }: { node: MessageNode; onOpen: (a: Artifact) => void }) {
  const { t } = useTranslation();
  const artifacts = findArtifacts(nodeText(node));
  if (artifacts.length === 0) return null;
  return (
    <div className="-mt-1 mb-4 flex flex-wrap gap-1.5 ps-[30px] text-xs" data-testid="artifacts">
      {artifacts.map((a, i) => (
        <button
          key={i}
          className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 hover:border-accent"
          onClick={() => onOpen(a)}
        >
          <span className="text-accent">▶</span>
          <span className="font-medium">{a.title}</span>
          <span className="text-text-secondary">{t(`artifacts.kind.${a.kind}`)}</span>
        </button>
      ))}
    </div>
  );
}

/** Under a blind comparison: vote, then see which model was which. */
function ArenaVote({ turn, replies, onVote }: { turn: MessageNode; replies: MessageNode[]; onVote?: (turn: MessageNode, winner: 'a' | 'b' | 'tie') => void }) {
  const { t } = useTranslation();
  const arena = turn.arena!;
  if (arena.winner && arena.models) {
    const picked = arena.winner === 'tie' ? t('arena.tie') : arena.models[arena.winner === 'a' ? 0 : 1];
    return (
      <p className="mb-3 text-center text-sm text-text-secondary" data-testid="arena-result">
        {t('arena.revealed', { a: arena.models[0], b: arena.models[1], picked })}
      </p>
    );
  }
  const busy = replies.some((r) => r.status === 'streaming');
  if (!onVote) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center justify-center gap-2 text-sm" data-testid="arena-vote" role="group" aria-label={t('arena.question')}>
      <span className="text-text-secondary">{t('arena.question')}</span>
      {(['a', 'tie', 'b'] as const).map((w) => (
        <button
          key={w}
          disabled={busy}
          onClick={() => onVote(turn, w)}
          className="rounded-full border border-border px-3 py-1 hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {t(`arena.vote_${w}`)}
        </button>
      ))}
    </div>
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
      className="mb-3 ms-[30px] rounded-lg border border-border bg-surface p-3 text-sm"
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
    <div className="mb-2 ms-[30px] mt-1" data-testid="follow-ups">
      <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-text-secondary">{t('chat.followUps')}</p>
      <div className="flex flex-col items-start gap-1.5">
        {items.map((q) => (
          <button
            key={q}
            className="rounded-lg border border-border px-3 py-1.5 text-start text-sm hover:border-accent hover:text-accent"
            onClick={() => onPick(q)}
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
