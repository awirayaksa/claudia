import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import type { MfaSetup } from '@shared/auth';
import {
  errorMessage,
  useLogoutMutation,
  useMfaConfirmMutation,
  useMfaDisableMutation,
  useMfaRecoveryCodesMutation,
  useMfaSetupMutation,
  useMyMfaQuery,
  useSessionQuery,
} from '../api/rtk-api';

/** The QR code as an image (the server's SVG never becomes part of the page). */
const qrSrc = (svg: string) => `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;

/** Ten codes, shown once: copy or download them. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone?: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  return (
    <div className="space-y-3" data-testid="recovery-codes">
      <p className="text-sm">{t('mfa.recoveryShownOnce')}</p>
      <ul className="grid grid-cols-2 gap-1 rounded border border-border bg-background p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}>
          {copied ? t('app.copied') : t('app.copy')}
        </Button>
        <a
          className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent"
          href={`data:text/plain;charset=utf-8,${encodeURIComponent(text + '\n')}`}
          download="claudia-recovery-codes.txt"
        >
          {t('mfa.download')}
        </a>
        {onDone && (
          <Button size="sm" onClick={onDone}>
            {t('app.done')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Scan, confirm with a code, keep the recovery codes; `onFinished` once they are put away. */
export function TwoFactorSetup({ onFinished }: { onFinished: () => void }) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [start, startState] = useMfaSetupMutation();
  const [confirm, confirmState] = useMfaConfirmMutation();

  if (codes) return <RecoveryCodes codes={codes} onDone={onFinished} />;
  if (!setup) {
    return (
      <div className="space-y-2">
        <Button
          size="sm"
          onClick={async () => {
            const res = await start();
            if ('data' in res && res.data) setSetup(res.data.setup);
          }}
          disabled={startState.isLoading}
        >
          {t('mfa.setUp')}
        </Button>
        {startState.error && <p className="text-sm text-error">{errorMessage(startState.error)}</p>}
      </div>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        const res = await confirm({ code });
        if ('data' in res && res.data) setCodes(res.data.recoveryCodes);
      }}
    >
      <p className="text-sm">{t('mfa.scan')}</p>
      <img src={qrSrc(setup.qrSvg)} alt={t('mfa.qrAlt')} className="h-44 w-44 rounded bg-white p-2" data-testid="mfa-qr" />
      <p className="text-xs text-text-secondary">
        {t('mfa.manual')} <code className="break-all font-mono" data-testid="mfa-secret">{setup.secret}</code>
      </p>
      <Input label={t('mfa.code')} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" />
      {confirmState.error && <p className="text-sm text-error">{errorMessage(confirmState.error)}</p>}
      <Button type="submit" size="sm" disabled={confirmState.isLoading || code.trim().length < 6}>
        {t('mfa.turnOn')}
      </Button>
    </form>
  );
}

/** Settings → Account: status, turn on, turn off, new recovery codes. */
export function TwoFactorSection() {
  const { t } = useTranslation();
  const { data, refetch: refetchMfa } = useMyMfaQuery();
  const { data: session, refetch: refetchSession } = useSessionQuery();
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disable, disableState] = useMfaDisableMutation();
  const [regenerate, regenState] = useMfaRecoveryCodesMutation();
  const enabled = data?.mfa.enabled ?? false;
  const error = errorMessage(disableState.error ?? regenState.error);

  return (
    <section className="max-w-md" data-testid="two-factor">
      <h3 className="mb-1 font-semibold">{t('mfa.title')}</h3>
      <p className="mb-3 text-sm text-text-secondary">{enabled ? t('mfa.isOn', { count: data?.mfa.recoveryCodesLeft ?? 0 }) : t('mfa.isOff')}</p>
      {!enabled && (
        <TwoFactorSetup
          onFinished={() => {
            void refetchMfa();
            void refetchSession();
          }}
        />
      )}
      {enabled && codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
      {enabled && !codes && (
        <div className="space-y-3">
          <Input label={t('mfa.currentCode')} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          {error && <p className="text-sm text-error">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={code.trim().length < 6 || regenState.isLoading}
              onClick={async () => {
                const res = await regenerate({ code });
                if ('data' in res && res.data) {
                  setCodes(res.data.recoveryCodes);
                  setCode('');
                }
              }}
            >
              {t('mfa.newCodes')}
            </Button>
            {!session?.mfa?.required && (
              <Button
                size="sm"
                variant="ghost"
                disabled={code.trim().length < 6 || disableState.isLoading}
                onClick={async () => {
                  const res = await disable({ code });
                  if ('data' in res) setCode('');
                }}
              >
                {t('mfa.turnOff')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** The admin requires two-factor sign-in: set it up before anything else. */
export function TwoFactorRequired() {
  const { t } = useTranslation();
  const { refetch } = useSessionQuery();
  const [logout] = useLogoutMutation();
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-md space-y-4 rounded-lg border border-border bg-surface p-5">
        <h1 className="text-lg font-semibold">{t('mfa.requiredTitle')}</h1>
        <p className="text-sm text-text-secondary">{t('mfa.requiredBody')}</p>
        <TwoFactorSetup onFinished={() => void refetch()} />
        <button
          className="text-sm text-accent hover:underline"
          onClick={async () => {
            await logout();
            void refetch();
          }}
        >
          {t('auth.signOut')}
        </button>
      </div>
    </main>
  );
}
