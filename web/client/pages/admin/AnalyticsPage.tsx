import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalyticsResponse, UsageTotals } from '@shared/admin';
import { errorMessage, useAnalyticsQuery } from '../../api/rtk-api';

const RANGES = [7, 30, 90] as const;

const fmt = (n: number) => n.toLocaleString();
const money = (n: number) => `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
const tokens = (u: UsageTotals) => u.promptTokens + u.completionTokens;

/** Admin: tokens, cost and activity over the last days (UTC). */
export function AnalyticsPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(30);
  const { data, error, isFetching } = useAnalyticsQuery(days);

  return (
    <div className="space-y-4" data-testid="analytics">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label={t('analytics.range')} className="flex gap-1">
          {RANGES.map((d) => (
            <button
              key={d}
              aria-pressed={days === d}
              onClick={() => setDays(d)}
              className={`rounded border px-3 py-1 text-sm ${days === d ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:text-text-primary'}`}
            >
              {t('analytics.lastDays', { count: d })}
            </button>
          ))}
        </div>
        <a className="text-sm text-accent underline" href={`/api/admin/analytics/export.csv?days=${days}`} download>
          {t('analytics.exportCsv')}
        </a>
      </div>

      {error && <p className="text-sm text-error">{errorMessage(error)}</p>}
      {!data && !error && <p className="text-sm text-text-secondary">{t('app.loading')}</p>}
      {data && (
        <div className={isFetching ? 'opacity-60' : ''}>
          <Summary data={data} />
          <section className="mt-4 rounded-lg border border-border bg-surface p-4">
            <h2 className="mb-1 font-semibold">{t('analytics.tokensPerDay')}</h2>
            <p className="mb-3 text-xs text-text-secondary">{t('analytics.utcNote')}</p>
            <DailyChart byDay={data.byDay} />
          </section>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Breakdown
              title={t('analytics.byModel')}
              rows={data.byModel.map((m) => ({ key: m.modelId, label: m.modelId, ...m }))}
              empty={t('analytics.noUsage')}
            />
            <Breakdown
              title={t('analytics.byUser')}
              rows={data.byUser.map((u) => ({ key: u.userId, label: u.name ? `${u.name} (${u.email})` : u.email, ...u }))}
              empty={t('analytics.noUsage')}
            />
            <Breakdown
              title={t('analytics.byKind')}
              rows={data.byKind.map((k) => ({ key: k.kind, label: t(`analytics.kinds.${k.kind}`, { defaultValue: k.kind }), ...k }))}
              empty={t('analytics.noUsage')}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function Summary({ data }: { data: AnalyticsResponse }) {
  const { t } = useTranslation();
  const cards: Array<[string, string]> = [
    [t('analytics.tokens'), fmt(tokens(data.totals))],
    [t('analytics.cost'), money(data.totals.cost)],
    [t('analytics.requests'), fmt(data.totals.requests)],
    [t('analytics.activeUsers'), fmt(data.totals.activeUsers)],
    [t('analytics.newChats'), fmt(data.totals.chats)],
    [t('analytics.messages'), fmt(data.totals.messages)],
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {cards.map(([label, value]) => (
        <div key={label} className="rounded-lg border border-border bg-surface p-3">
          <dt className="text-xs text-text-secondary">{label}</dt>
          <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Stacked bars (prompt, completion) per day; the table under it is the accessible version. */
function DailyChart({ byDay }: { byDay: AnalyticsResponse['byDay'] }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...byDay.map(tokens));
  const w = 100 / byDay.length;
  const shown = hover !== null ? byDay[hover] : null;
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={t('analytics.tokensPerDay')}>
        {byDay.map((d, i) => {
          const total = (tokens(d) / max) * 38;
          const prompt = (d.promptTokens / max) * 38;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={i * w} y={0} width={w} height={40} fill="transparent" />
              <rect x={i * w + w * 0.15} y={40 - total} width={w * 0.7} height={total - prompt} className="fill-accent opacity-50" />
              <rect x={i * w + w * 0.15} y={40 - prompt} width={w * 0.7} height={prompt} className="fill-accent" />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-xs text-text-secondary">
        <span>{byDay[0]?.day}</span>
        <span aria-live="polite">
          {shown ? (
            t('analytics.dayDetail', { day: shown.day, prompt: fmt(shown.promptTokens), completion: fmt(shown.completionTokens), requests: fmt(shown.requests) })
          ) : (
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-accent" /> {t('analytics.prompt')}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-sm bg-accent opacity-50" /> {t('analytics.completion')}
              </span>
            </span>
          )}
        </span>
        <span>{byDay.at(-1)?.day}</span>
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-text-secondary">{t('analytics.showTable')}</summary>
        <table className="mt-2 w-full text-left text-xs">
          <thead>
            <tr className="text-text-secondary">
              <th className="py-1">{t('analytics.day')}</th>
              <th>{t('analytics.prompt')}</th>
              <th>{t('analytics.completion')}</th>
              <th>{t('analytics.requests')}</th>
              <th>{t('analytics.activeUsers')}</th>
              <th>{t('analytics.cost')}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {byDay.map((d) => (
              <tr key={d.day} className="border-t border-border">
                <td className="py-1">{d.day}</td>
                <td>{fmt(d.promptTokens)}</td>
                <td>{fmt(d.completionTokens)}</td>
                <td>{fmt(d.requests)}</td>
                <td>{fmt(d.activeUsers)}</td>
                <td>{money(d.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

function Breakdown({ title, rows, empty }: { title: string; rows: Array<UsageTotals & { key: string; label: string }>; empty: string }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...rows.map(tokens));
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-text-secondary">{empty}</p>
      ) : (
        <table className="w-full table-fixed text-left text-sm">
          <thead>
            <tr className="text-xs text-text-secondary">
              <th className="w-1/2 pb-1 font-normal" />
              <th className="pb-1 text-right font-normal">{t('analytics.tokens')}</th>
              <th className="pb-1 text-right font-normal">{t('analytics.requests')}</th>
              <th className="pb-1 text-right font-normal">{t('analytics.cost')}</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-border">
                <td className="py-1.5 pr-2">
                  <div className="truncate" title={r.label}>
                    {r.label}
                  </div>
                  <div className="mt-1 h-1 rounded bg-accent/20">
                    <div className="h-1 rounded bg-accent" style={{ width: `${(tokens(r) / max) * 100}%` }} />
                  </div>
                </td>
                <td className="text-right">{fmt(tokens(r))}</td>
                <td className="text-right">{fmt(r.requests)}</td>
                <td className="text-right">{money(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
