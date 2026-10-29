/** Writing styles of your own: write them, have them written from a sample, share them. */
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { StyleView } from '@shared/styles';
import {
  errorMessage,
  useCreateStyleMutation,
  useDeleteStyleMutation,
  useGenerateStyleMutation,
  useSessionQuery,
  useStylesQuery,
  useUpdateStyleMutation,
} from '../../api/rtk-api';
import { AccessDialog } from '../../workspace/AccessDialog';

const field = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm';

export function StylesSettings() {
  const { t } = useTranslation();
  const { data } = useStylesQuery();
  const [remove] = useDeleteStyleMutation();
  const [editing, setEditing] = useState<StyleView | 'new' | null>(null);
  const [sharing, setSharing] = useState<StyleView | null>(null);
  const list = data?.styles ?? [];

  return (
    <div className="space-y-4 p-5">
      <p className="text-sm text-text-secondary">{t('styles.help')}</p>
      <ul className="divide-y divide-border rounded border border-border" data-testid="styles">
        {list.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {s.name}
                {s.scope !== 'builtin' && s.scope !== 'mine' && (
                  <span className="ms-2 text-xs font-normal text-text-secondary">
                    {s.scope === 'everyone' ? t('styles.forEveryone') : t('styles.sharedBy', { name: s.ownerName ?? '' })}
                  </span>
                )}
              </div>
              {s.description && <div className="truncate text-xs text-text-secondary">{s.description}</div>}
            </div>
            {s.canEdit && (
              <button className="text-xs text-text-secondary hover:text-accent" onClick={() => setEditing(s)}>
                {t('app.edit')}
              </button>
            )}
            {s.canManage && s.scope === 'mine' && (
              <button className="text-xs text-text-secondary hover:text-accent" onClick={() => setSharing(s)}>
                {t('styles.share')}
              </button>
            )}
            {s.canManage && (
              <button className="text-xs text-error hover:underline" onClick={() => void remove(s.id)}>
                {t('app.delete')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {editing ? (
        <StyleForm style={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      ) : (
        <Button size="sm" onClick={() => setEditing('new')} data-testid="new-style">
          {t('styles.new')}
        </Button>
      )}
      {sharing && <AccessDialog kind="styles" id={sharing.id} name={sharing.name} onClose={() => setSharing(null)} />}
    </div>
  );
}

function StyleForm({ style, onDone }: { style: StyleView | null; onDone: () => void }) {
  const { t } = useTranslation();
  const { data: session } = useSessionQuery();
  const [create, createState] = useCreateStyleMutation();
  const [update, updateState] = useUpdateStyleMutation();
  const [generate, genState] = useGenerateStyleMutation();
  const [name, setName] = useState(style?.name ?? '');
  const [description, setDescription] = useState(style?.description ?? '');
  const [instructions, setInstructions] = useState(style?.instructions ?? '');
  const [everyone, setEveryone] = useState(false);
  const [samples, setSamples] = useState('');
  const [about, setAbout] = useState('');
  const error = errorMessage(createState.error ?? updateState.error ?? genState.error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name: name.trim(), description: description.trim(), instructions: instructions.trim() };
    const res = style ? await update({ id: style.id, ...body }) : await create({ ...body, ...(everyone ? { everyone: true } : {}) });
    if (!('error' in res)) onDone();
  };

  const draft = async () => {
    const res = await generate({ ...(samples.trim() ? { samples } : {}), ...(about.trim() ? { description: about } : {}) });
    if ('data' in res && res.data) {
      if (!name.trim()) setName(res.data.name);
      if (!description.trim()) setDescription(res.data.description);
      setInstructions(res.data.instructions);
    }
  };

  return (
    <form className="space-y-3 rounded border border-border p-3" onSubmit={submit} data-testid="style-form">
      {!style && (
        <details className="rounded border border-border p-2 text-sm" open>
          <summary className="cursor-pointer font-medium">{t('styles.writeForMe')}</summary>
          <p className="mt-1 text-xs text-text-secondary">{t('styles.writeForMeHelp')}</p>
          <textarea
            className={`${field} mt-2`}
            rows={5}
            placeholder={t('styles.samples')}
            aria-label={t('styles.samples')}
            value={samples}
            onChange={(e) => setSamples(e.target.value)}
          />
          <input className={`${field} mt-2`} placeholder={t('styles.describe')} aria-label={t('styles.describe')} value={about} onChange={(e) => setAbout(e.target.value)} />
          <Button type="button" size="sm" variant="secondary" className="mt-2" disabled={(!samples.trim() && !about.trim()) || genState.isLoading} onClick={() => void draft()}>
            {genState.isLoading ? t('styles.writing') : t('styles.write')}
          </Button>
        </details>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <input className={field} placeholder={t('styles.name')} aria-label={t('styles.name')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        <input
          className={field}
          placeholder={t('styles.description')}
          aria-label={t('styles.description')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
        />
      </div>
      <textarea
        className={field}
        rows={6}
        placeholder={t('styles.instructionsPlaceholder')}
        aria-label={t('styles.instructions')}
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        required
        maxLength={4000}
      />
      {!style && session?.user?.role === 'admin' && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
          {t('styles.everyone')}
        </label>
      )}
      {error && <p className="text-sm text-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>
          {t('app.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!name.trim() || !instructions.trim() || createState.isLoading || updateState.isLoading}>
          {t('app.save')}
        </Button>
      </div>
    </form>
  );
}
