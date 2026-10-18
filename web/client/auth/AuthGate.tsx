import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionQuery } from '../api/rtk-api';
import { onSessionLost } from '../api/http';
import { LoginPage } from '../pages/LoginPage';
import { PendingPage } from '../pages/PendingPage';
import { FullPageMessage } from '../components/FullPageMessage';
import { TwoFactorRequired } from './TwoFactor';

/** Shows sign-in or the waiting screen until there is an approved user. */
export function AuthGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useSessionQuery();

  // A refresh that failed anywhere means the session is over: re-check it
  useEffect(() => onSessionLost(() => void refetch()), [refetch]);

  if (isLoading) return <FullPageMessage>{t('app.loading')}</FullPageMessage>;
  if (isError || !data) {
    return (
      <FullPageMessage>
        <p className="mb-3">{t('app.error')}</p>
        <button className="text-accent hover:underline" onClick={() => refetch()}>
          {t('app.retry')}
        </button>
      </FullPageMessage>
    );
  }
  if (!data.user) return <LoginPage auth={data.auth} />;
  if (data.user.role === 'pending') return <PendingPage email={data.user.email} />;
  if (data.mfa?.required) return <TwoFactorRequired />;
  return <>{children}</>;
}
