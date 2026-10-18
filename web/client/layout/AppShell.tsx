import { useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLoadSettingsFromStore } from '@/hooks/useLoadSettingsFromStore';
import { toggleSidebar } from '@/store/slices/uiSlice';
import { useAppDispatch, useAppSelector } from '@/store';
import { Sidebar } from './Sidebar';
import { BannerBar } from './BannerBar';
import { MenuIcon } from '../components/icons';
import { useMcpSync } from '../chat/useMcpSync';
import { usePlugins } from '../plugins/loader';

/**
 * Sidebar + content. On wide screens the sidebar is a column (collapsible);
 * on phones it is a drawer over the content.
 */
export function AppShell() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const sidebarOpen = useAppSelector((s) => s.ui.sidebarOpen);
  const appTitle = useAppSelector((s) => s.settings.appearance.customization?.appTitle) || t('app.name');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { reload } = useLoadSettingsFromStore();
  // Tool servers and skills into the shared slices (composer badges, /skills)
  useMcpSync();
  // The admin's renderer plugins
  usePlugins(true);

  // The user's appearance and preferences into the shared settings slice
  useEffect(() => {
    void reload();
  }, [reload]);

  // Close the drawer after navigating
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    document.title = appTitle;
  }, [appTitle]);

  // Browsers reserve Ctrl+N/T/W, so new chat is Ctrl+Shift+O (as in other chat apps)
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        navigate('/');
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (window.matchMedia('(min-width: 768px)').matches) dispatch(toggleSidebar());
        else setDrawerOpen((o) => !o);
      } else if (e.key === 'Escape') {
        setDrawerOpen(false);
      }
    },
    [dispatch, navigate]
  );
  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden bg-background text-text-primary">
      {/* Wide screens: a column */}
      {sidebarOpen && (
        <aside className="hidden w-72 shrink-0 border-r border-border bg-surface md:flex md:flex-col">
          <Sidebar />
        </aside>
      )}

      {/* Phones: a drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <button
            className="absolute inset-0 bg-black/40"
            aria-label={t('nav.closeMenu')}
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="relative flex h-full w-[85%] max-w-xs flex-col border-r border-border bg-surface shadow-xl">
            <Sidebar />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <button
            className="rounded p-2 hover:bg-surface"
            aria-label={t('nav.openMenu')}
            onClick={() => setDrawerOpen(true)}
            data-testid="open-menu"
          >
            <MenuIcon />
          </button>
          <span className="truncate font-semibold">{appTitle}</span>
        </header>
        {!sidebarOpen && (
          <button
            className="absolute left-2 top-2 z-10 hidden rounded p-2 hover:bg-surface md:block"
            aria-label={t('nav.openMenu')}
            onClick={() => dispatch(toggleSidebar())}
          >
            <MenuIcon />
          </button>
        )}
        <BannerBar />
        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
