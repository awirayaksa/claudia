/**
 * Abbreviates model names for compact display in UI
 * @param modelName - Full model name from API
 * @returns Abbreviated, human-readable model name
 */
export function abbreviateModelName(modelName: string): string {
  if (!modelName) return '';

  // Common patterns for different model providers
  const patterns = [
    // Claude models: "claude-3-opus-20240229" → "Claude 3 Opus"
    {
      regex: /^claude-(\d+(?:\.\d+)?)-(\w+)(?:-\d+)?$/i,
      format: (matches: RegExpMatchArray) => `Claude ${matches[1]} ${capitalize(matches[2])}`,
    },
    // GPT models: "gpt-4-turbo" → "GPT-4 Turbo", "gpt-3.5-turbo" → "GPT-3.5 Turbo"
    {
      regex: /^gpt-(\d+(?:\.\d+)?)-?(\w+)?$/i,
      format: (matches: RegExpMatchArray) =>
        matches[2] ? `GPT-${matches[1]} ${capitalize(matches[2])}` : `GPT-${matches[1]}`,
    },
    // Gemini models: "gemini-pro" → "Gemini Pro"
    {
      regex: /^gemini-(\w+)$/i,
      format: (matches: RegExpMatchArray) => `Gemini ${capitalize(matches[1])}`,
    },
    // Llama models: "llama-2-70b" → "Llama 2 70B"
    {
      regex: /^llama-(\d+)-(\d+b)$/i,
      format: (matches: RegExpMatchArray) => `Llama ${matches[1]} ${matches[2].toUpperCase()}`,
    },
  ];

  // Try each pattern
  for (const pattern of patterns) {
    const matches = modelName.match(pattern.regex);
    if (matches) {
      return pattern.format(matches);
    }
  }

  // Fallback: capitalize first letter of each word, replace hyphens/underscores
  return modelName
    .split(/[-_]/)
    .map(word => capitalize(word))
    .join(' ');
}

/**
 * Capitalizes the first letter of a string
 */
function capitalize(str: string): string {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

/**
 * Truncates a model name to a maximum length, adding ellipsis if needed
 * @param modelName - Model name to truncate
 * @param maxLength - Maximum length (default: 15)
 * @returns Truncated model name
 */
export function truncateModelName(modelName: string, maxLength: number = 15): string {
  if (!modelName || modelName.length <= maxLength) return modelName;
  return modelName.slice(0, maxLength - 1) + '…';
}
