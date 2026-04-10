import React, { useEffect, useState, useCallback } from 'react';
import { getAPIProvider } from '../../services/api/provider.service';

export interface PromptSuggestion {
  title: string;
  subtitle: string;
  prompt: string;
}

interface SuggestedPromptsProps {
  onSelect: (prompt: string) => void;
  model: string;
}

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
- "title": A short catchy title (2-4 words)
- "subtitle": A brief description of the topic (5-10 words)
- "prompt": A detailed, well-crafted prompt that the user would actually send (1-3 sentences, specific and actionable)

The prompt should be significantly more detailed than the title+subtitle summary. Cover different categories like learning, creativity, problem-solving, writing, etc.

Respond ONLY with a valid JSON array, no markdown, no code fences, no explanation. Example format:
[{"title":"Help me study","subtitle":"vocabulary for a college entrance exam","prompt":"Help me study vocabulary: write a sentence for me to fill in the blank, and I'll try to pick the correct option."}]`,
          },
        ],
        stream: false,
        max_tokens: 500,
        temperature: 1.0,
      });

      const content = response.choices[0]?.message?.content;
      if (content && typeof content === 'string') {
        // Extract JSON array from the response (handle possible markdown fences)
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
    <div className="mt-4 w-full pl-4">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-text-secondary">
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span>Suggested</span>
      </div>
      <div className="flex flex-col gap-1">
        {suggestions.map((suggestion, index) => (
          <button
            key={index}
            onClick={() => onSelect(suggestion.prompt)}
            className="group flex flex-col items-start rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-hover"
          >
            <span className="text-sm font-medium text-text-primary">
              {suggestion.title}
            </span>
            <span className="text-xs text-text-secondary">
              {suggestion.subtitle}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};
