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

const CARD_ICONS = [
  // Code / debug
  <svg key="code" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
  // Chart / analyze
  <svg key="chart" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>,
  // Spark / ideas
  <svg key="spark" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l4 4M15 15l4 4M5 19l4-4M15 9l4-4"/></svg>,
];

const DEFAULT_SUGGESTIONS: PromptSuggestion[] = [
  {
    emoji: '📝',
    title: 'Draft an email',
    subtitle: 'Write a clear, professional message',
    prompt: 'Help me write a professional email to my team announcing a project update. The tone should be clear, concise, and encouraging.',
  },
  {
    emoji: '🐛',
    title: 'Debug my code',
    subtitle: 'Find and fix an issue in my code',
    prompt: 'I have a bug in my code and I\'m not sure what\'s causing it. Can you help me walk through the problem step by step and suggest a fix?',
  },
  {
    emoji: '🧠',
    title: 'Explain a concept',
    subtitle: 'Break down something complex simply',
    prompt: 'Explain a complex technical concept to me as if I were new to the field. Use analogies and simple language to make it easy to understand.',
  },
  {
    emoji: '🎨',
    title: 'Brainstorm ideas',
    subtitle: 'Generate creative suggestions',
    prompt: 'Help me brainstorm creative ideas for a new project. I want diverse, innovative suggestions across different categories.',
  },
  {
    emoji: '📊',
    title: 'Analyze data',
    subtitle: 'Interpret patterns and insights',
    prompt: 'I have some data I need help analyzing. Can you help me identify patterns, trends, and key insights from it?',
  },
  {
    emoji: '✅',
    title: 'Plan my day',
    subtitle: 'Organize tasks and priorities',
    prompt: 'Help me create a structured daily plan. I\'ll share my tasks and you can help me prioritize them and schedule them efficiently.',
  },
  {
    emoji: '🔍',
    title: 'Research a topic',
    subtitle: 'Summarize key facts and context',
    prompt: 'I want to learn about a specific topic quickly. Give me a concise overview with the most important facts, context, and key points to know.',
  },
  {
    emoji: '💬',
    title: 'Improve my writing',
    subtitle: 'Polish prose for clarity and style',
    prompt: 'I have a piece of writing I\'d like to improve. Can you review it for clarity, flow, and style, then suggest specific edits?',
  },
  {
    emoji: '🚀',
    title: 'Plan a project',
    subtitle: 'Break goals into actionable steps',
    prompt: 'Help me plan a new project from scratch. I\'ll describe my goal and constraints, and you can help me create a realistic roadmap with milestones.',
  },
  {
    emoji: '🤔',
    title: 'Think through a decision',
    subtitle: 'Weigh pros, cons, and trade-offs',
    prompt: 'I\'m facing a difficult decision and need help thinking it through. Can you help me map out the pros, cons, and potential outcomes for each option?',
  },
];

function getRandomDefaultSuggestions(count: number): PromptSuggestion[] {
  const shuffled = [...DEFAULT_SUGGESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

export const SuggestedPrompts: React.FC<SuggestedPromptsProps> = ({
  onSelect,
  model,
}) => {
  const [suggestions, setSuggestions] = useState<PromptSuggestion[]>([]);
  const [, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

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

  const displayed = failed && suggestions.length === 0
    ? getRandomDefaultSuggestions(3)
    : suggestions;

  if (displayed.length === 0) {
    return null;
  }

  return (
    <div className="mt-8">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        Suggested
      </p>
      <div className="grid grid-cols-3 gap-2.5">
        {displayed.map((suggestion, index) => (
          <button
            key={index}
            onClick={() => onSelect(suggestion.prompt)}
            className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-surface p-4 text-left transition-colors hover:bg-surface-hover hover:border-accent hover:border-opacity-40"
          >
            <div
              className="flex items-center justify-center rounded-md text-accent"
              style={{ width: 26, height: 26, background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)' }}
            >
              {CARD_ICONS[index % CARD_ICONS.length]}
            </div>
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
