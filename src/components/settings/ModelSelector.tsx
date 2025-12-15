
interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
  models: string[];
}

export function ModelSelector({ value, onChange, models }: ModelSelectorProps) {
  // Sort models alphabetically
  const sortedModels = [...models].sort((a, b) => a.localeCompare(b));

  return (
    <div className="w-full">
      <label className="mb-1.5 block text-sm font-medium text-text-primary">
        Default Model
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-border bg-background px-3 py-2 text-sm text-text-primary transition-colors hover:border-accent focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
      >
        <option value="">Select a model...</option>
        {sortedModels.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      <p className="mt-1 text-sm text-text-secondary">
        Choose the default model to use for new conversations
      </p>
    </div>
  );
}
