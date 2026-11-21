/**
 * Desktop: tool calls waiting for the user. Each card shows the tool, its
 * server and the arguments, with Allow once, Always allow and Deny; the reply
 * continues once every waiting call is answered.
 */
import { useState } from 'react';
import { Button } from '../common/Button';
import { useAppDispatch, useAppSelector } from '../../store';
import { answerToolApproval } from '../../store/slices/chatSlice';
import { ToolIntegrationService } from '../../services/mcp/tool-integration.service';
import type { ApprovalDecision } from '../../services/mcp/tool-approvals';
import type { ToolCall } from '../../types/message.types';
import { useT } from '../../i18n';

export function ToolApprovalCards() {
  const awaiting = useAppSelector((state) => state.chat.awaitingApproval);
  const messages = useAppSelector((state) => state.chat.messages);
  if (awaiting.length === 0) return null;
  const calls = awaiting
    .map((id) => messages.flatMap((m) => m.toolCalls ?? []).find((c) => c.id === id))
    .filter((c): c is ToolCall => !!c);
  return (
    <div className="my-3 space-y-2">
      {calls.map((call) => (
        <ApprovalCard key={call.id} call={call} />
      ))}
    </div>
  );
}

function ApprovalCard({ call }: { call: ToolCall }) {
  const t = useT();
  const dispatch = useAppDispatch();
  const mcp = useAppSelector((state) => state.mcp);
  const [sent, setSent] = useState(false);
  const target = ToolIntegrationService.resolveTool(call.function.name, mcp);
  const tool = target?.tool ?? call.function.name;
  const server = target ? mcp.servers[target.serverId]?.name ?? mcp.serverStates[target.serverId]?.config.name : undefined;

  let args: string;
  try {
    args = JSON.stringify(JSON.parse(call.function.arguments || '{}'), null, 2);
  } catch {
    args = call.function.arguments;
  }

  const answer = (decision: ApprovalDecision) => {
    setSent(true);
    dispatch(answerToolApproval({ callId: call.id, decision }));
  };

  return (
    <div
      className="rounded-lg border border-accent bg-surface p-3 text-sm"
      role="group"
      aria-label={t('tool.approvalTitle', 'Allow this tool to run?')}
      data-testid="tool-approval"
    >
      <div className="font-medium text-text-primary">{t('tool.approvalTitle', 'Allow this tool to run?')}</div>
      <div className="mb-2 text-xs text-text-secondary">
        <span className="font-mono">{tool}</span>
        {server && <span> · {server}</span>}
      </div>
      {args && args !== '{}' && (
        <pre className="mb-3 max-h-64 overflow-auto rounded bg-background p-2 text-xs text-text-primary">{args}</pre>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => answer('once')} disabled={sent} data-testid="allow-once">
          {t('tool.allowOnce', 'Allow once')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => answer('always')} disabled={sent} data-testid="allow-always">
          {t('tool.allowAlways', 'Always allow')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => answer('deny')} disabled={sent} data-testid="deny-tool">
          {t('tool.deny', 'Deny')}
        </Button>
      </div>
    </div>
  );
}
