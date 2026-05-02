import * as Tooltip from '@radix-ui/react-tooltip';

interface TokenUsageIndicatorProps {
  tokensUsed: number;
  contextWindow: number | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  isStreaming: boolean;
  modelId: string | undefined;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function getBarColor(pct: number): string {
  if (pct > 85) return 'bg-error';
  if (pct >= 60) return 'bg-amber-500';
  return 'bg-success';
}

function getTextColor(pct: number): string {
  if (pct > 85) return 'text-error';
  if (pct >= 60) return 'text-amber-500';
  return 'text-success';
}

export function TokenUsageIndicator({
  tokensUsed,
  contextWindow,
  promptTokens,
  completionTokens,
  cachedTokens,
  isStreaming,
  modelId,
}: TokenUsageIndicatorProps) {
  const hasWindow = contextWindow != null && contextWindow > 0;
  const pct = hasWindow ? Math.min(100, Math.round((tokensUsed / contextWindow!) * 100)) : null;

  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <div className="flex items-center gap-2 cursor-default select-none">
            {hasWindow ? (
              <>
                <span className="text-xs text-text-secondary tabular-nums">
                  {formatTokens(tokensUsed)} / {formatTokens(contextWindow!)}
                </span>
                <div className="h-1 w-16 rounded-full bg-surface overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${getBarColor(pct!)}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className={`text-xs font-medium tabular-nums ${getTextColor(pct!)}`}>
                  {pct}%
                </span>
              </>
            ) : (
              <span className="text-xs text-text-secondary tabular-nums">
                {formatTokens(tokensUsed)} tokens
              </span>
            )}
            {isStreaming && (
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
              </span>
            )}
          </div>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="end"
            sideOffset={6}
            className="z-50 rounded-lg border border-border bg-surface px-3 py-2 shadow-lg max-w-xs"
          >
            <div className="space-y-1 text-xs text-text-secondary">
              {modelId && (
                <div className="font-medium text-text-primary truncate">{modelId}</div>
              )}
              <div className="flex justify-between gap-4">
                <span>Prompt</span>
                <span className="tabular-nums text-text-primary">{promptTokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>Completion</span>
                <span className="tabular-nums text-text-primary">{completionTokens.toLocaleString()}</span>
              </div>
              {cachedTokens > 0 && (
                <div className="flex justify-between gap-4">
                  <span>Cached</span>
                  <span className="tabular-nums text-text-primary">{cachedTokens.toLocaleString()}</span>
                </div>
              )}
              {hasWindow ? (
                <>
                  <div className="border-t border-border my-1" />
                  <div className="flex justify-between gap-4">
                    <span>Context</span>
                    <span className="tabular-nums text-text-primary">
                      {formatTokens(tokensUsed)} / {formatTokens(contextWindow!)} ({pct}%)
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span>Remaining</span>
                    <span className="tabular-nums text-text-primary">
                      {Math.max(0, contextWindow! - tokensUsed).toLocaleString()}
                    </span>
                  </div>
                </>
              ) : (
                <div className="text-text-secondary italic">Window unknown</div>
              )}
            </div>
            <Tooltip.Arrow className="fill-surface" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
