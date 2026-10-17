import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import type { AuthOptions } from '@shared/auth';
import { errorMessage, useLoginMutation, useSignupMutation } from '../api/rtk-api';

export function LoginPage({ auth }: { auth: AuthOptions }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [login, loginState] = useLoginMutation();
  const [signup, signupState] = useSignupMutation();
  const busy = loginState.isLoading || signupState.isLoading;
  const error = errorMessage(mode === 'login' ? loginState.error : signupState.error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'login') await login({ email, password });
    else await signup({ name, email, password });
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-semibold text-text-primary">{t('app.name')}</h1>
        <p className="mb-6 text-center text-sm text-text-secondary">
          {mode === 'login' ? t('auth.signIn') : t('auth.signUp')}
        </p>

        {!auth.passwordLogin ? (
          <p className="rounded border border-border bg-surface p-4 text-sm text-text-secondary">{t('auth.passwordDisabled')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-surface p-5" noValidate>
            {mode === 'signup' && (
              <Input label={t('auth.name')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            )}
            <Input
              label={t('auth.email')}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
            <Input
              label={t('auth.password')}
              type="password"
              showPasswordToggle
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
            />
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {mode === 'login' ? t('auth.signIn') : t('auth.signUp')}
            </Button>
          </form>
        )}

        {auth.passwordLogin && (
          <p className="mt-4 text-center text-sm text-text-secondary">
            {mode === 'login' ? (
              auth.signup ? (
                <>
                  {t('auth.noAccount')}{' '}
                  <button type="button" className="text-accent hover:underline" onClick={() => setMode('signup')}>
                    {t('auth.signUp')}
                  </button>
                </>
              ) : (
                t('auth.signupDisabled')
              )
            ) : (
              <>
                {t('auth.haveAccount')}{' '}
                <button type="button" className="text-accent hover:underline" onClick={() => setMode('login')}>
                  {t('auth.signIn')}
                </button>
              </>
            )}
          </p>
        )}
      </div>
    </main>
  );
}
