import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { api, useLogoutMutation, useSessionQuery } from '../api/rtk-api';
import { useWebDispatch } from '../hooks';

export function PendingPage({ email }: { email: string }) {
  const { t } = useTranslation();
  const { refetch, isFetching } = useSessionQuery();
  const [logout] = useLogoutMutation();
  const dispatch = useWebDispatch();

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6 text-center">
        <h1 className="mb-2 text-xl font-semibold text-text-primary">{t('auth.pendingTitle')}</h1>
        <p className="mb-6 text-sm text-text-secondary">{t('auth.pendingBody', { email })}</p>
        <div className="flex justify-center gap-3">
          <Button variant="secondary" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {t('auth.pendingCheck')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              await logout();
              dispatch(api.util.resetApiState());
            }}
          >
            {t('auth.signOut')}
          </Button>
        </div>
      </div>
    </main>
  );
}
