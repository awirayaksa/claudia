/**
 * Tool calls of a reply that wait for the user: what the tool will do, with
 * Approve and Reject. The run continues once one is picked (in any tab).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { MessageNode, PartOf } from '@/types/turn.types';

/** Argument values as short readable text. */
function show(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((v) => typeof v !== 'object')) return value.join(', ');
  return JSON.stringify(value);
}

/** `onAnswer` may return a promise; when it fails, the buttons work again. */
type Answer = (callId: string, approved: boolean) => Promise<unknown> | void;

export function ToolApprovals({ node, onAnswer }: { node: MessageNode; onAnswer: Answer }) {
  const pending = node.parts.filter((p): p is PartOf<'tool_call'> => p.type === 'tool_call' && p.approval === 'pending');
  if (pending.length === 0) return null;
  return (
    <div className="mb-4 space-y-2 ps-[30px]">
      {pending.map((call) => (
        <ApprovalCard key={call.callId} call={call} onAnswer={(approved) => onAnswer(call.callId, approved)} />
      ))}
    </div>
  );
}

function ApprovalCard({ call, onAnswer }: { call: PartOf<'tool_call'>; onAnswer: (approved: boolean) => Promise<unknown> | void }) {
  const { t } = useTranslation();
  const [sent, setSent] = useState(false);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.args || '{}') as Record<string, unknown>;
  } catch {
    args = { arguments: call.args };
  }
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const answer = (approved: boolean) => {
    setSent(true);
    Promise.resolve(onAnswer(approved)).catch(() => setSent(false));
  };

  return (
    <div className="rounded-lg border border-accent bg-surface p-3 text-sm" role="group" aria-label={t('approval.title')} data-testid="tool-approval">
      <div className="font-medium">{t(`approval.tools.${call.tool}`, { defaultValue: t('approval.title') })}</div>
      <div className="mb-2 font-mono text-xs text-text-secondary">{call.tool}</div>
      {entries.length > 0 && (
        <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-text-secondary">{k}</dt>
              <dd className="whitespace-pre-wrap break-words">{show(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => answer(true)} disabled={sent} data-testid="approve-tool">
          {t('approval.approve')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => answer(false)} disabled={sent} data-testid="reject-tool">
          {t('approval.reject')}
        </Button>
        <span className="text-xs text-text-secondary">{t('approval.help')}</span>
      </div>
    </div>
  );
}
