import { useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import type { PromptView } from '@shared/workspace';
import { fillTemplate, templateVariables } from '@shared/prompts';

/**
 * Asks for a prompt's {{variables}}, then hands back the filled text (system
 * variables like {{CURRENT_DATE}} are filled in without asking).
 */
export function PromptVariablesForm({
  prompt,
  userName,
  onInsert,
  onClose,
}: {
  prompt: Pick<PromptView, 'title' | 'body'>;
  userName: string;
  onInsert: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const vars = useMemo(() => templateVariables(prompt.body), [prompt.body]);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(vars.map((v) => [v.name, v.default])));

  const fill = (v: Record<string, string>) =>
    fillTemplate(prompt.body, v, {
      userName,
      language: typeof navigator !== 'undefined' ? navigator.language : undefined,
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onInsert(fill(values));
  };

  return (
    <Modal isOpen onClose={onClose} title={prompt.title}>
      <form className="space-y-3" onSubmit={submit} data-testid="prompt-variables">
        {vars.map((v, i) => (
          <label key={v.name} className="block text-sm">
            <span className="mb-1 block font-medium">{v.name}</span>
            <textarea
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
              rows={1}
              autoFocus={i === 0}
              value={values[v.name] ?? ''}
              onChange={(e) => setValues({ ...values, [v.name]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  onInsert(fill(values));
                }
              }}
              aria-label={v.name}
            />
          </label>
        ))}
        <div>
          <span className="mb-1 block text-xs font-medium text-text-secondary">{t('workspace.preview')}</span>
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-background px-2 py-1.5 text-sm">
            {fill(values)}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button type="submit" size="sm">
            {t('workspace.insert')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
