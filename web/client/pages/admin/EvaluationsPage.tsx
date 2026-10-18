import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { errorMessage, useAppSettingsQuery, useLeaderboardQuery, useModelsQuery, useUpdateAppSettingMutation } from '../../api/rtk-api';
import { ARENA_MODEL_ID } from '@shared/arena';

/** Admin → Evaluations: blind comparisons (which models take part) and the leaderboard. */
export function EvaluationsPage() {
  const { t } = useTranslation();
  const { data: settings } = useAppSettingsQuery();
  const { data: models } = useModelsQuery();
  const { data: board } = useLeaderboardQuery();
  const [save, saveState] = useUpdateAppSettingMutation();
  const [enabled, setEnabled] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    if (settings) {
      setEnabled(settings.settings.arena.enabled);
      setPicked(settings.settings.arena.models);
    }
  }, [settings]);
  const all = (models?.models ?? []).filter((m) => m.id !== ARENA_MODEL_ID && !m.own);

  return (
    <div className="space-y-4" data-testid="evaluations">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('arena.settingsTitle')}</h2>
        <p className="mb-3 mt-1 text-sm text-text-secondary">{t('arena.settingsHelp')}</p>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('arena.enable')}
        </label>
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          {all.map((m) => (
            <label key={m.id} className="flex items-center gap-2 truncate text-sm">
              <input
                type="checkbox"
                checked={picked.includes(m.id)}
                onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))}
              />
              <span className="truncate" title={m.id}>
                {m.name}
              </span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" onClick={() => void save({ key: 'arena', value: { enabled, models: picked } })} disabled={saveState.isLoading}>
            {t('app.save')}
          </Button>
          {enabled && picked.length < 2 && <span className="text-sm text-text-secondary">{t('arena.needTwo')}</span>}
          {saveState.isSuccess && <span className="text-sm text-success">{t('app.saved')}</span>}
          {saveState.error && <span className="text-sm text-error">{errorMessage(saveState.error)}</span>}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="font-semibold">{t('arena.leaderboard')}</h2>
        <p className="mb-3 mt-1 text-sm text-text-secondary">{t('arena.leaderboardHelp', { count: board?.votes ?? 0 })}</p>
        {board && board.rows.length > 0 ? (
          <table className="w-full text-left text-sm" data-testid="leaderboard">
            <thead className="text-xs text-text-secondary">
              <tr>
                <th className="py-1 font-normal">#</th>
                <th className="font-normal">{t('arena.model')}</th>
                <th className="text-right font-normal">{t('arena.rating')}</th>
                <th className="text-right font-normal">{t('arena.wins')}</th>
                <th className="text-right font-normal">{t('arena.losses')}</th>
                <th className="text-right font-normal">{t('arena.ties')}</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {board.rows.map((r, i) => (
                <tr key={r.modelId} className="border-t border-border">
                  <td className="py-1.5">{i + 1}</td>
                  <td className="truncate">{r.modelId}</td>
                  <td className="text-right font-medium">{r.rating}</td>
                  <td className="text-right">{r.wins}</td>
                  <td className="text-right">{r.losses}</td>
                  <td className="text-right">{r.ties}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-text-secondary">{t('arena.noVotes')}</p>
        )}
      </section>

      {board && board.ratings.length > 0 && (
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-3 font-semibold">{t('arena.thumbs')}</h2>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-text-secondary">
              <tr>
                <th className="py-1 font-normal">{t('arena.model')}</th>
                <th className="text-right font-normal">👍</th>
                <th className="text-right font-normal">👎</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {board.ratings.map((r) => (
                <tr key={r.modelId} className="border-t border-border">
                  <td className="py-1.5">{r.modelId}</td>
                  <td className="text-right">{r.up}</td>
                  <td className="text-right">{r.down}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
