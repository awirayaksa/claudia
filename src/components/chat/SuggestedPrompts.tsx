import React, { useEffect, useState, useCallback } from 'react';
import { getAPIProvider } from '../../services/api/provider.service';

export interface PromptSuggestion {
  title: string;
  subtitle: string;
  prompt: string;
  emoji?: string;
}

interface SuggestedPromptsProps {
  onSelect: (prompt: string) => void;
  model: string;
}

const FALLBACK_EMOJIS = ['💡', '✍️', '🔍'];

export const SuggestedPrompts: React.FC<SuggestedPromptsProps> = ({
  onSelect,
  model,
}) => {
  const [suggestions, setSuggestions] = useState<PromptSuggestion[]>([]);
  const [, setLoading] = useState(false);
  const [, setFailed] = useState(false);

  const fetchSuggestions = useCallback(async () => {
    if (!model) return;

    setLoading(true);
    setFailed(false);

    try {
      const provider = getAPIProvider();
      const response = await provider.chatCompletion({
        model,
        messages: [
          {
            role: 'user',
            content: `Generate 3 diverse conversation starter suggestions. Each suggestion should have:
- "emoji": A single relevant emoji
- "title": A short catchy title (2-4 words)
- "subtitle": A brief description of the topic (5-10 words)
- "prompt": A detailed, well-crafted prompt that the user would actually send (1-3 sentences, specific and actionable)

The prompt should be significantly more detailed than the title+subtitle summary. Cover different categories like learning, creativity, problem-solving, writing, etc.

Respond ONLY with a valid JSON array, no markdown, no code fences, no explanation. Example format:
[{"emoji":"📚","title":"Help me study","subtitle":"vocabulary for a college entrance exam","prompt":"Help me study vocabulary: write a sentence for me to fill in the blank, and I'll try to pick the correct option."}]`,
          },
        ],
        stream: false,
        max_tokens: 600,
        temperature: 1.0,
      });

      const content = response.choices[0]?.message?.content;
      if (content && typeof content === 'string') {
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as PromptSuggestion[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            setSuggestions(parsed.slice(0, 3));
            return;
          }
        }
      }
      setFailed(true);
    } catch (error) {
      console.error('Failed to generate prompt suggestions:', error);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [model]);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  if (suggestions.length === 0) {
    return null;
  }

  return (
    <div className="mt-8">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        Suggested
      </p>
      <div className="grid grid-cols-3 gap-2.5">
        {suggestions.map((suggestion, index) => (
          <button
            key={index}
            onClick={() => onSelect(suggestion.prompt)}
            className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:bg-surface-hover hover:border-accent hover:border-opacity-40"
          >
            <span className="text-xl leading-none">
              {suggestion.emoji || FALLBACK_EMOJIS[index]}
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary leading-snug">
                {suggestion.title}
              </p>
              <p className="mt-0.5 text-xs text-text-secondary leading-snug">
                {suggestion.subtitle}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
