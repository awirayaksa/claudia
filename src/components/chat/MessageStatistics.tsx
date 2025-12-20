import { useState } from 'react';
import { MessageUsage } from '../../types/statistics.types';

interface MessageStatisticsProps {
  usage: MessageUsage;
}

export function MessageStatistics({ usage }: MessageStatisticsProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!usage) {
    return null;
  }

  const formatNumber = (num: number | undefined | null) => {
    if (num === undefined || num === null) return 'N/A';
    return num.toLocaleString();
  };

  const formatCost = (cost: number | undefined | null) => {
    if (cost === undefined || cost === null) return 'N/A';
    return `$${cost.toFixed(6)}`;
  };

  return (
    <div className="my-2 rounded-lg border border-border bg-purple-500 bg-opacity-10 p-3">
      {/* Collapsible header button */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-lg">📊</span>
          <span className="font-mono text-sm font-medium text-text-primary">
            Statistics
          </span>
          <span className="text-xs text-text-secondary">
            {formatNumber(usage.total_tokens)} tokens
            {(usage.cost !== undefined && usage.cost !== null) && ` • ${formatCost(usage.cost)}`}
          </span>
        </div>
        <span className="ml-4 text-text-secondary">
          {isExpanded ? '▼' : '▶'}
        </span>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="mt-3 w-full border-t border-border pt-3">
          <div className="space-y-3">
            {/* Basic Token Counts - Always shown */}
            <div className="rounded bg-surface p-3">
              <h4 className="mb-2 text-xs font-semibold text-text-secondary uppercase">
                Token Usage
              </h4>
              <div className="grid grid-cols-3 gap-4 text-xs">
                <div>
                  <div className="text-text-secondary">Prompt</div>
                  <div className="font-mono text-text-primary">
                    {formatNumber(usage.prompt_tokens)}
                  </div>
                </div>
                <div>
                  <div className="text-text-secondary">Completion</div>
                  <div className="font-mono text-text-primary">
                    {formatNumber(usage.completion_tokens)}
                  </div>
                </div>
                <div>
                  <div className="text-text-secondary">Total</div>
                  <div className="font-mono text-text-primary font-semibold">
                    {formatNumber(usage.total_tokens)}
                  </div>
                </div>
              </div>
            </div>

            {/* Prompt Token Details - Conditional */}
            {usage.prompt_tokens_details && (
              <div className="rounded bg-surface p-3">
                <h4 className="mb-2 text-xs font-semibold text-text-secondary uppercase">
                  Prompt Details
                </h4>
                <div className="grid grid-cols-3 gap-4 text-xs">
                  {usage.prompt_tokens_details.cached_tokens !== undefined && (
                    <div>
                      <div className="text-text-secondary">Cached</div>
                      <div className="font-mono text-text-primary">
                        {formatNumber(usage.prompt_tokens_details.cached_tokens)}
                      </div>
                    </div>
                  )}
                  {usage.prompt_tokens_details.audio_tokens !== undefined && (
                    <div>
                      <div className="text-text-secondary">Audio</div>
                      <div className="font-mono text-text-primary">
                        {formatNumber(usage.prompt_tokens_details.audio_tokens)}
                      </div>
                    </div>
                  )}
                  {usage.prompt_tokens_details.video_tokens !== undefined && (
                    <div>
                      <div className="text-text-secondary">Video</div>
                      <div className="font-mono text-text-primary">
                        {formatNumber(usage.prompt_tokens_details.video_tokens)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Completion Token Details - Conditional */}
            {usage.completion_tokens_details && (
              <div className="rounded bg-surface p-3">
                <h4 className="mb-2 text-xs font-semibold text-text-secondary uppercase">
                  Completion Details
                </h4>
                <div className="grid grid-cols-2 gap-4 text-xs">
                  {usage.completion_tokens_details.reasoning_tokens !== undefined && (
                    <div>
                      <div className="text-text-secondary">Reasoning</div>
                      <div className="font-mono text-text-primary">
                        {formatNumber(usage.completion_tokens_details.reasoning_tokens)}
                      </div>
                    </div>
                  )}
                  {usage.completion_tokens_details.image_tokens !== undefined && (
                    <div>
                      <div className="text-text-secondary">Image</div>
                      <div className="font-mono text-text-primary">
                        {formatNumber(usage.completion_tokens_details.image_tokens)}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Cost Information - Conditional */}
            {((usage.cost !== undefined && usage.cost !== null) || usage.cost_details) && (
              <div className="rounded bg-surface p-3">
                <h4 className="mb-2 text-xs font-semibold text-text-secondary uppercase">
                  Cost
                </h4>
                <div className="space-y-2 text-xs">
                  {(usage.cost !== undefined && usage.cost !== null) && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Total Cost</span>
                      <span className="font-mono text-text-primary font-semibold">
                        {formatCost(usage.cost)}
                      </span>
                    </div>
                  )}
                  {usage.cost_details?.upstream_inference_cost !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Upstream Inference</span>
                      <span className="font-mono text-text-primary">
                        {formatCost(usage.cost_details.upstream_inference_cost)}
                      </span>
                    </div>
                  )}
                  {usage.cost_details?.upstream_inference_prompt_cost !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Prompt Cost</span>
                      <span className="font-mono text-text-primary">
                        {formatCost(usage.cost_details.upstream_inference_prompt_cost)}
                      </span>
                    </div>
                  )}
                  {usage.cost_details?.upstream_inference_completions_cost !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Completion Cost</span>
                      <span className="font-mono text-text-primary">
                        {formatCost(usage.cost_details.upstream_inference_completions_cost)}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Provider-specific flags - Conditional */}
            {(usage.is_hvwk !== undefined || usage.is_byok !== undefined) && (
              <div className="rounded bg-surface p-3">
                <h4 className="mb-2 text-xs font-semibold text-text-secondary uppercase">
                  Provider Info
                </h4>
                <div className="space-y-2 text-xs">
                  {usage.is_hvwk !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">HVWK</span>
                      <span className="font-mono text-text-primary">
                        {usage.is_hvwk ? 'Yes' : 'No'}
                      </span>
                    </div>
                  )}
                  {usage.is_byok !== undefined && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">BYOK (Bring Your Own Key)</span>
                      <span className="font-mono text-text-primary">
                        {usage.is_byok ? 'Yes' : 'No'}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
