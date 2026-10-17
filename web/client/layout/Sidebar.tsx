import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toggleSidebar } from '@/store/slices/uiSlice';
import { useAppDispatch } from '@/store';
import type { ChatSummary, Folder } from '@shared/chats';
import {
  api,
  useChatsQuery,
  useCreateFolderMutation,
  useDeleteChatMutation,
  useDeleteFolderMutation,
  useFoldersQuery,
  useLogoutMutation,
  useSessionQuery,
  useUpdateChatMutation,
  useUpdateFolderMutation,
} from '../api/rtk-api';
import { useWebDispatch } from '../hooks';
import { Menu, type MenuItem } from '../components/Menu';
import { ChevronIcon, DotsIcon, FolderIcon, PinIcon, PlusIcon, SearchIcon, SidebarIcon } from '../components/icons';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Sidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appDispatch = useAppDispatch();
  const webDispatch = useWebDispatch();
  const { id: activeId } = useParams();
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 250);
  const { data: chatData, isLoading } = useChatsQuery(query ? { search: query } : undefined);
  const { data: folderData } = useFoldersQuery();
  const { data: session } = useSessionQuery();
  const [logout] = useLogoutMutation();
  const [createFolder] = useCreateFolderMutation();
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [newFolderName, setNewFolderName] = useState<string | null>(null);

  const chats = chatData?.chats ?? [];
  const folders = folderData?.folders ?? [];
  const pinned = chats.filter((c) => c.pinned);
  const byFolder = (folderId: string) => chats.filter((c) => !c.pinned && c.folderId === folderId);
  const unfiled = chats.filter((c) => !c.pinned && !c.folderId);

  const signOut = async () => {
    await logout();
    webDispatch(api.util.resetApiState());
    navigate('/');
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 p-3">
        <Link
          to="/"
          className="flex flex-1 items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:border-accent"
          data-testid="new-chat"
        >
          <PlusIcon />
          {t('nav.newChat')}
        </Link>
        <button
          className="hidden rounded p-2 text-text-secondary hover:bg-background md:block"
          aria-label={t('nav.closeMenu')}
          onClick={() => appDispatch(toggleSidebar())}
        >
          <SidebarIcon />
        </button>
      </div>

      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm focus-within:border-accent">
          <SearchIcon />
          <input
            className="w-full bg-transparent outline-none placeholder:text-text-secondary"
            placeholder={t('nav.search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('nav.search')}
          />
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-sm" aria-label={t('nav.recent')}>
        {pinned.length > 0 && (
          <Section title={t('nav.pinned')}>
            {pinned.map((c) => (
              <ChatItem key={c.id} chat={c} folders={folders} active={c.id === activeId} />
            ))}
          </Section>
        )}

        {!query && (
          <Section
            title={t('nav.folders')}
            action={
              <button
                className="rounded p-0.5 text-text-secondary hover:text-text-primary"
                aria-label={t('nav.newFolder')}
                onClick={() => setNewFolderName('')}
              >
                <PlusIcon />
              </button>
            }
          >
            {newFolderName !== null && (
              <form
                className="px-2 py-1"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (newFolderName.trim()) await createFolder({ name: newFolderName.trim() });
                  setNewFolderName(null);
                }}
              >
                <input
                  autoFocus
                  className="w-full rounded border border-border bg-background px-2 py-1 outline-none focus:border-accent"
                  placeholder={t('nav.folderName')}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  onBlur={() => !newFolderName.trim() && setNewFolderName(null)}
                />
              </form>
            )}
            {folders.map((f) => (
              <FolderItem
                key={f.id}
                folder={f}
                open={!!openFolders[f.id]}
                onToggle={() => setOpenFolders((o) => ({ ...o, [f.id]: !o[f.id] }))}
              >
                {byFolder(f.id).map((c) => (
                  <ChatItem key={c.id} chat={c} folders={folders} active={c.id === activeId} />
                ))}
              </FolderItem>
            ))}
          </Section>
        )}

        <Section title={t('nav.recent')}>
          {isLoading ? null : (query ? chats : unfiled).length === 0 ? (
            <p className="px-2 py-1 text-text-secondary">{query ? t('nav.noResults') : t('nav.noChats')}</p>
          ) : (
            (query ? chats : unfiled).map((c) => (
              <ChatItem key={c.id} chat={c} folders={folders} active={c.id === activeId} />
            ))
          )}
        </Section>
      </nav>

      <div className="flex items-center gap-2 border-t border-border p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{session?.user?.name}</div>
          <div className="truncate text-xs text-text-secondary">{session?.user?.email}</div>
        </div>
        <Menu
          label={t('nav.settings')}
          trigger={<DotsIcon />}
          placement="above"
          items={[
            { label: t('nav.settings'), onSelect: () => navigate('/settings') },
            ...(session?.user?.role === 'admin' ? [{ label: t('nav.admin'), onSelect: () => navigate('/admin/users') }] : []),
            'separator',
            { label: t('auth.signOut'), onSelect: signOut },
          ]}
        />
      </div>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mt-3">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 className="text-xs font-medium uppercase tracking-wide text-text-secondary">{title}</h2>
        {action}
      </div>
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

function FolderItem({
  folder,
  open,
  onToggle,
  children,
}: {
  folder: Folder;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [updateFolder] = useUpdateFolderMutation();
  const [deleteFolder] = useDeleteFolderMutation();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const [confirm, setConfirm] = useState(false);

  return (
    <li>
      <div className="group flex items-center gap-1 rounded px-1 hover:bg-background">
        <button className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left" onClick={onToggle} aria-expanded={open}>
          <ChevronIcon open={open} />
          <FolderIcon />
          {renaming ? (
            <input
              autoFocus
              className="min-w-0 flex-1 rounded border border-border bg-background px-1 outline-none"
              value={name}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  if (name.trim()) await updateFolder({ id: folder.id, name: name.trim() });
                  setRenaming(false);
                } else if (e.key === 'Escape') setRenaming(false);
              }}
              onBlur={() => setRenaming(false)}
            />
          ) : (
            <span className="truncate">{folder.name}</span>
          )}
        </button>
        <div className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <Menu
            label={t('chat.actions')}
            trigger={<DotsIcon />}
            items={[
              { label: t('app.rename'), onSelect: () => setRenaming(true) },
              { label: t('app.delete'), danger: true, onSelect: () => setConfirm(true) },
            ]}
          />
        </div>
      </div>
      {open && <ul className="ml-4 space-y-0.5 border-l border-border pl-1">{children}</ul>}
      <ConfirmDialog
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setConfirm(false);
          await deleteFolder(folder.id);
        }}
        title={t('chat.deleteFolderTitle')}
        message={t('chat.deleteFolderBody', { name: folder.name })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </li>
  );
}

function ChatItem({ chat, folders, active }: { chat: ChatSummary; folders: Folder[]; active: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [updateChat] = useUpdateChatMutation();
  const [deleteChat] = useDeleteChatMutation();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [confirm, setConfirm] = useState(false);

  const items: Array<MenuItem | 'separator' | { heading: string }> = [
    {
      label: t('app.rename'),
      onSelect: () => {
        setTitle(chat.title);
        setRenaming(true);
      },
    },
    { label: chat.pinned ? t('chat.unpin') : t('chat.pin'), onSelect: () => void updateChat({ id: chat.id, pinned: !chat.pinned }) },
    { label: t('chat.archive'), onSelect: () => void updateChat({ id: chat.id, archived: true }) },
    'separator',
    { heading: t('chat.moveTo') },
    {
      label: t('chat.noFolder'),
      inset: true,
      disabled: !chat.folderId,
      onSelect: () => void updateChat({ id: chat.id, folderId: null }),
    },
    ...folders.map((f) => ({
      label: f.name,
      inset: true,
      disabled: chat.folderId === f.id,
      onSelect: () => void updateChat({ id: chat.id, folderId: f.id }),
    })),
    'separator',
    { label: t('app.delete'), danger: true, onSelect: () => setConfirm(true) },
  ];

  return (
    <li>
      <div
        className={`group flex items-center gap-1 rounded px-2 ${active ? 'bg-background font-medium' : 'hover:bg-background'}`}
      >
        {renaming ? (
          <input
            autoFocus
            className="my-1 min-w-0 flex-1 rounded border border-border bg-background px-1 py-0.5 outline-none focus:border-accent"
            value={title}
            aria-label={t('app.rename')}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                if (title.trim() && title.trim() !== chat.title) await updateChat({ id: chat.id, title: title.trim() });
                setRenaming(false);
              } else if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <NavLink to={`/c/${chat.id}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5" title={chat.title}>
            {chat.pinned && (
              <span className="shrink-0 text-text-secondary">
                <PinIcon />
              </span>
            )}
            <span className="truncate">{chat.title}</span>
          </NavLink>
        )}
        <div className="opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
          <Menu label={t('chat.actions')} trigger={<DotsIcon />} items={items} />
        </div>
      </div>
      <ConfirmDialog
        isOpen={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          setConfirm(false);
          await deleteChat(chat.id);
          if (active) navigate('/');
        }}
        title={t('chat.deleteTitle')}
        message={t('chat.deleteBody', { title: chat.title })}
        confirmText={t('app.delete')}
        cancelText={t('app.cancel')}
        isDestructive
      />
    </li>
  );
}
