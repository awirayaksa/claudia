import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-text-primary">
      <h1 className="text-xl font-semibold">{t('notFound.title')}</h1>
      <Link to="/" className="text-accent hover:underline">
        {t('notFound.back')}
      </Link>
    </main>
  );
}
