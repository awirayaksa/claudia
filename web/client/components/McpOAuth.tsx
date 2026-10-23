/**
 * OAuth sign-in for remote MCP servers: the form fields (on/off, and an
 * optional pre-registered client) and the Connect / Reconnect / Disconnect
 * controls. Signing in happens in a pop-up that ends on Claudia's callback.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import type { McpOAuthInput, McpOAuthView } from '@shared/mcp';

export interface OAuthDraft {
  on: boolean;
  clientId: string;
  /** Write-only: blank keeps the stored one. */
  clientSecret: string;
  scope: string;
}

export const oauthDraft = (view: McpOAuthView | null | undefined): OAuthDraft => ({
  on: !!view,
  clientId: view?.clientId ?? '',
  clientSecret: '',
  scope: view?.scope ?? '',
});

/** What the API takes: null switches OAuth off. */
export function oauthInput(d: OAuthDraft): McpOAuthInput | null {
  if (!d.on) return null;
  return {
    ...(d.clientId.trim() ? { clientId: d.clientId.trim() } : {}),
    ...(d.clientId.trim() && d.clientSecret ? { clientSecret: d.clientSecret } : {}),
    ...(d.scope.trim() ? { scope: d.scope.trim() } : {}),
  };
}

export function OAuthFields({ value, onChange, stored }: { value: OAuthDraft; onChange: (d: OAuthDraft) => void; stored?: McpOAuthView | null }) {
  const { t } = useTranslation();
  const field = 'w-full rounded border border-border bg-background px-2 py-1.5 text-sm';
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} data-testid="mcp-oauth" />
        <span>
          {t('mcpOAuth.use')}
          <span className="block text-xs text-text-secondary">{t('mcpOAuth.useHelp')}</span>
        </span>
      </label>
      {value.on && (
        <details className="ms-6">
          <summary className="cursor-pointer text-xs text-text-secondary">{t('mcpOAuth.advanced')}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <input
              className={field}
              placeholder={t('mcpOAuth.clientId')}
              aria-label={t('mcpOAuth.clientId')}
              value={value.clientId}
              onChange={(e) => onChange({ ...value, clientId: e.target.value })}
            />
            <input
              className={field}
              type="password"
              autoComplete="off"
              placeholder={stored?.hasClientSecret ? t('mcpOAuth.secretKept') : t('mcpOAuth.clientSecret')}
              aria-label={t('mcpOAuth.clientSecret')}
              value={value.clientSecret}
              disabled={!value.clientId.trim()}
              onChange={(e) => onChange({ ...value, clientSecret: e.target.value })}
            />
            <input
              className={field}
              placeholder={t('mcpOAuth.scope')}
              aria-label={t('mcpOAuth.scope')}
              value={value.scope}
              onChange={(e) => onChange({ ...value, scope: e.target.value })}
            />
          </div>
          <p className="mt-1 text-xs text-text-secondary">{t('mcpOAuth.advancedHelp')}</p>
        </details>
      )}
    </div>
  );
}

/** "Connected" / "Sign-in needed", with the buttons to change it. */
export function OAuthControls({
  oauth,
  connectUrl,
  refetch,
  onDisconnect,
  disabled,
}: {
  oauth: McpOAuthView;
  /** Opened in the pop-up. */
  connectUrl: string;
  /** Reload the server (to see whether it is connected now). */
  refetch: () => Promise<boolean>;
  onDisconnect: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const popup = useRef<Window | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => () => void (timer.current && clearInterval(timer.current)), []);

  const connect = () => {
    popup.current = window.open(connectUrl, 'claudia-mcp-oauth', 'width=520,height=680');
    setWaiting(true);
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const done = await refetch().catch(() => false);
      if (done || !popup.current || popup.current.closed) {
        if (timer.current) clearInterval(timer.current);
        popup.current?.close();
        setWaiting(false);
      }
    }, 1500);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full border px-2 py-0.5 text-xs ${oauth.connected ? 'border-success/50 text-success' : 'border-warning/50 text-warning'}`}
        data-testid="mcp-oauth-state"
      >
        {oauth.connected ? t('mcpOAuth.connected') : t('mcpOAuth.needed')}
      </span>
      <Button size="sm" variant={oauth.connected ? 'secondary' : 'primary'} disabled={disabled || waiting} onClick={connect}>
        {waiting ? t('mcpOAuth.waiting') : oauth.connected ? t('mcpOAuth.reconnect') : t('mcpOAuth.connect')}
      </Button>
      {oauth.connected && (
        <Button size="sm" variant="ghost" onClick={onDisconnect}>
          {t('mcpOAuth.disconnect')}
        </Button>
      )}
    </span>
  );
}
