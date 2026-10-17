import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import type { AuthOptions } from '@shared/auth';
import { errorMessage, useLdapLoginMutation, useLoginMutation, useSignupMutation } from '../api/rtk-api';

type Mode = 'login' | 'signup' | 'ldap';

export function LoginPage({ auth }: { auth: AuthOptions }) {
  const { t } = useTranslation();
  // Directory sign-in first when it's on: that's what most people on such installs use
  const [mode, setMode] = useState<Mode>(auth.ldap ? 'ldap' : 'login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [login, loginState] = useLoginMutation();
  const [ldapLogin, ldapState] = useLdapLoginMutation();
  const [signup, signupState] = useSignupMutation();
  const busy = loginState.isLoading || signupState.isLoading || ldapState.isLoading;
  const error = errorMessage(mode === 'login' ? loginState.error : mode === 'ldap' ? ldapState.error : signupState.error);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'login') await login({ email, password });
    else if (mode === 'ldap') await ldapLogin({ username, password });
    else await signup({ name, email, password });
  };

  const showForm = mode === 'ldap' ? auth.ldap : auth.passwordLogin;
  const title = mode === 'signup' ? t('auth.signUp') : t('auth.signIn');

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-background px-4 py-8">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-semibold text-text-primary">{t('app.name')}</h1>
        <p className="mb-6 text-center text-sm text-text-secondary">{title}</p>

        {auth.ldap && auth.passwordLogin && mode !== 'signup' && (
          <div role="tablist" className="mb-3 flex rounded-lg border border-border bg-surface p-1 text-sm">
            {(['ldap', 'login'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                className={`flex-1 rounded px-3 py-1.5 ${mode === m ? 'bg-background font-medium shadow-sm' : 'text-text-secondary'}`}
                onClick={() => setMode(m)}
              >
                {m === 'ldap' ? t('auth.directoryAccount') : t('auth.localAccount')}
              </button>
            ))}
          </div>
        )}

        {!showForm ? (
          <p className="rounded border border-border bg-surface p-4 text-sm text-text-secondary">{t('auth.passwordDisabled')}</p>
        ) : (
          <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-surface p-5" noValidate>
            {mode === 'signup' && (
              <Input label={t('auth.name')} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            )}
            {mode === 'ldap' ? (
              <Input
                label={t('auth.username')}
                helperText={t('auth.usernameHelp')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                required
              />
            ) : (
              <Input
                label={t('auth.email')}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            )}
            <Input
              label={t('auth.password')}
              type="password"
              showPasswordToggle
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              required
            />
            {error && (
              <p role="alert" className="text-sm text-error">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy || !password}>
              {title}
            </Button>
          </form>
        )}

        {auth.passwordLogin && mode !== 'ldap' && (
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
