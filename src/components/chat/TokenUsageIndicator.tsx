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

function getGradient(pct: number): string {
  if (pct > 85) return 'linear-gradient(90deg, #ef4444, #f87171)';
  if (pct >= 60) return 'linear-gradient(90deg, #f59e0b, #fbbf24)';
  return 'linear-gradient(90deg, #22c55e, #4ade80)';
}

function getBadgeBg(pct: number): string {
  if (pct > 85) return 'bg-red-500/10 text-red-500';
  if (pct >= 60) return 'bg-amber-500/10 text-amber-500';
  return 'bg-emerald-500/10 text-emerald-500';
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
          <div className="flex items-center gap-2.5 cursor-default select-none">
            {hasWindow ? (
              <>
                <span className="text-xs text-text-secondary tabular-nums font-medium">
                  {formatTokens(tokensUsed)} / {formatTokens(contextWindow!)}
                </span>

                <div className="h-2 w-24 rounded-full bg-surface ring-1 ring-inset ring-border overflow-hidden relative">
                  <div
                    className="h-full rounded-full transition-all duration-500 ease-out shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]"
                    style={{
                      width: `${pct}%`,
                      background: getGradient(pct!),
                      boxShadow:
                        pct! > 85
                          ? '0 0 8px rgba(239,68,68,0.45), inset 0 1px 0 rgba(255,255,255,0.3)'
                          : pct! >= 60
                          ? '0 0 6px rgba(245,158,11,0.35), inset 0 1px 0 rgba(255,255,255,0.3)'
                          : '0 0 4px rgba(34,197,94,0.25), inset 0 1px 0 rgba(255,255,255,0.3)',
                    }}
                  />
                </div>

                <span
                  className={`tabular-nums text-[10px] font-bold px-1.5 py-0.5 rounded-md leading-none ${getBadgeBg(
                    pct!
                  )}`}
                >
                  {pct}%
                </span>
              </>
            ) : (
              <span className="text-xs text-text-secondary tabular-nums font-medium">
                {formatTokens(tokensUsed)} tokens
              </span>
            )}

            {isStreaming && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-accent" />
              </span>
            )}
          </div>
        </Tooltip.Trigger>

        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            align="end"
            sideOffset={6}
            className="z-50 rounded-xl border border-border bg-surface px-4 py-3 shadow-xl max-w-xs"
          >
            <div className="space-y-1.5 text-xs text-text-secondary">
              {modelId && (
                <div className="font-semibold text-text-primary truncate pb-0.5">{modelId}</div>
              )}
              <div className="flex justify-between gap-6">
                <span>Prompt</span>
                <span className="tabular-nums text-text-primary font-medium">{promptTokens.toLocaleString()}</span>
              </div>
              <div className="flex justify-between gap-6">
                <span>Completion</span>
                <span className="tabular-nums text-text-primary font-medium">{completionTokens.toLocaleString()}</span>
              </div>
              {cachedTokens > 0 && (
                <div className="flex justify-between gap-6">
                  <span>Cached</span>
                  <span className="tabular-nums text-text-primary font-medium">{cachedTokens.toLocaleString()}</span>
                </div>
              )}
              {hasWindow ? (
                <>
                  <div className="border-t border-border my-1.5" />
                  <div className="flex justify-between gap-6">
                    <span>Context</span>
                    <span className="tabular-nums text-text-primary font-medium">
                      {formatTokens(tokensUsed)} / {formatTokens(contextWindow!)} ({pct}%)
                    </span>
                  </div>
                  <div className="flex justify-between gap-6">
                    <span>Remaining</span>
                    <span className="tabular-nums text-text-primary font-medium">
                      {Math.max(0, contextWindow! - tokensUsed).toLocaleString()}
                    </span>
                  </div>
                </>
              ) : (
                <div className="text-text-secondary italic pt-0.5">Window unknown</div>
              )}
            </div>
            <Tooltip.Arrow className="fill-surface" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
