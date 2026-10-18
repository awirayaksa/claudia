import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import { SidebarExtras } from './SidebarExtras';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { toggleSidebar } from '@/store/slices/uiSlice';
import { useAppDispatch } from '@/store';
import { SNIPPET_MARK_END, SNIPPET_MARK_START, type ChatSummary, type Folder } from '@shared/chats';
import {
  api,
  useChatsQuery,
  useCreateFolderMutation,
  useDeleteChatMutation,
  useDeleteFolderMutation,
  useFoldersQuery,
  useLogoutMutation,
  useSessionQuery,
  useTagsQuery,
  useUpdateChatMutation,
  useUpdateFolderMutation,
} from '../api/rtk-api';
import { useWebDispatch } from '../hooks';
import { Menu, type MenuItem } from '../components/Menu';
import { ArchiveIcon, ChevronIcon, DotsIcon, FolderIcon, PinIcon, PlusIcon, SearchIcon, SidebarIcon, TagIcon } from '../components/icons';
import { FolderSettings } from './FolderSettings';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Folders as a tree, with each folder's depth (for "Move to" lists). */
function folderTree(folders: Folder[]) {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const key = f.parentId && folders.some((p) => p.id === f.parentId) ? f.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), f]);
  }
  const flat: Array<{ folder: Folder; depth: number }> = [];
  const walk = (parent: string | null, depth: number, seen: Set<string>) => {
    for (const f of byParent.get(parent) ?? []) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      flat.push({ folder: f, depth });
      walk(f.id, depth + 1, seen);
    }
  };
  walk(null, 0, new Set());
  /** The folder and everything inside it. */
  const within = (id: string): Set<string> => {
    const out = new Set([id]);
    for (const { folder } of flat) if (folder.parentId && out.has(folder.parentId)) out.add(folder.id);
    return out;
  };
  return { byParent, flat, within };
}

type Tree = ReturnType<typeof folderTree>;

export function Sidebar() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const appDispatch = useAppDispatch();
  const webDispatch = useWebDispatch();
  const { id: activeId } = useParams();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const query = useDebounced(search.trim(), 250);
  const filtered = !!query || !!tag;
  const { data: chatData, isLoading } = useChatsQuery({
    ...(query ? { search: query } : {}),
    ...(tag ? { tag } : {}),
    ...(archived ? { archived: true } : {}),
  });
  const { data: folderData } = useFoldersQuery();
  const { data: tagData } = useTagsQuery();
  const { data: session } = useSessionQuery();
  const [logout] = useLogoutMutation();
  const [createFolder] = useCreateFolderMutation();
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [newFolder, setNewFolder] = useState<{ parentId: string | null; name: string } | null>(null);

  const chats = chatData?.chats ?? [];
  const folders = folderData?.folders ?? [];
  const tags = tagData?.tags ?? [];
  const tree = useMemo(() => folderTree(folders), [folders]);
  const pinned = chats.filter((c) => c.pinned);
  const inFolder = (folderId: string) => chats.filter((c) => !c.pinned && c.folderId === folderId);
  const unfiled = chats.filter((c) => !c.pinned && (!c.folderId || !folders.some((f) => f.id === c.folderId)));

  // A tag that's no longer used stops filtering
  useEffect(() => {
    if (tag && tagData && !tags.some((x) => x.tag === tag)) setTag(null);
  }, [tag, tagData, tags]);

  const signOut = async () => {
    await logout();
    webDispatch(api.util.resetApiState());
    navigate('/');
  };

  const startFolder = (parentId: string | null) => {
    setNewFolder({ parentId, name: '' });
    if (parentId) setOpenFolders((o) => ({ ...o, [parentId]: true }));
  };

  const newFolderForm = (parentId: string | null) =>
    newFolder && newFolder.parentId === parentId ? (
      <form
        className="px-2 py-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (newFolder.name.trim()) await createFolder({ name: newFolder.name.trim(), parentId });
          setNewFolder(null);
        }}
      >
        <input
          autoFocus
          className="w-full rounded border border-border bg-background px-2 py-1 outline-none focus:border-accent"
          placeholder={t('nav.folderName')}
          value={newFolder.name}
          onChange={(e) => setNewFolder({ parentId, name: e.target.value })}
          onBlur={() => !newFolder.name.trim() && setNewFolder(null)}
          onKeyDown={(e) => e.key === 'Escape' && setNewFolder(null)}
        />
      </form>
    ) : null;

  const renderFolder = (f: Folder): React.ReactNode => (
    <FolderItem
      key={f.id}
      folder={f}
      tree={tree}
      open={!!openFolders[f.id]}
      onToggle={() => setOpenFolders((o) => ({ ...o, [f.id]: !o[f.id] }))}
      onNewSubfolder={() => startFolder(f.id)}
    >
      {newFolderForm(f.id)}
      {(tree.byParent.get(f.id) ?? []).map(renderFolder)}
      {inFolder(f.id).map((c) => (
        <ChatItem key={c.id} chat={c} tree={tree} active={c.id === activeId} />
      ))}
    </FolderItem>
  );

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
        {tags.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1" aria-label={t('nav.tags')}>
            {tags.map(({ tag: name, count }) => (
              <button
                key={name}
                aria-pressed={tag === name}
                className={`rounded-full border px-2 py-0.5 text-xs ${tag === name ? 'border-accent bg-accent/10 text-accent' : 'border-border text-text-secondary hover:border-accent'}`}
                onClick={() => setTag(tag === name ? null : name)}
                title={t('nav.tagCount', { count })}
              >
                #{name}
              </button>
            ))}
          </div>
        )}
      </div>

      <SidebarExtras />

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 text-sm" aria-label={t('nav.recent')}>
        {archived && (
          <div className="flex items-center justify-between px-2 pt-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-text-secondary">{t('nav.archived')}</h2>
            <button className="text-xs text-accent hover:underline" onClick={() => setArchived(false)}>
              {t('nav.backToChats')}
            </button>
          </div>
        )}

        {!archived && pinned.length > 0 && !filtered && (
          <Section title={t('nav.pinned')}>
            {pinned.map((c) => (
              <ChatItem key={c.id} chat={c} tree={tree} active={c.id === activeId} />
            ))}
          </Section>
        )}

        {!archived && !filtered && (
          <Section
            title={t('nav.folders')}
            action={
              <button
                className="rounded p-0.5 text-text-secondary hover:text-text-primary"
                aria-label={t('nav.newFolder')}
                onClick={() => startFolder(null)}
              >
                <PlusIcon />
              </button>
            }
          >
            {newFolderForm(null)}
            {(tree.byParent.get(null) ?? []).map(renderFolder)}
          </Section>
        )}

        <Section title={archived ? '' : filtered ? t('nav.results') : t('nav.recent')}>
          {isLoading ? null : (filtered || archived ? chats : unfiled).length === 0 ? (
            <p className="px-2 py-1 text-text-secondary">
              {filtered ? t('nav.noResults') : archived ? t('nav.noArchived') : t('nav.noChats')}
            </p>
          ) : (
            (filtered || archived ? chats : unfiled).map((c) => (
              <ChatItem key={c.id} chat={c} tree={tree} active={c.id === activeId} />
            ))
          )}
        </Section>
      </nav>

      <div className="flex items-center gap-2 border-t border-border p-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{session?.user?.name}</div>
          <div className="truncate text-xs text-text-secondary">{session?.user?.email}</div>
        </div>
        <button
          className={`rounded p-1 hover:bg-background ${archived ? 'text-accent' : 'text-text-secondary hover:text-text-primary'}`}
          aria-label={t('nav.archived')}
          aria-pressed={archived}
          title={t('nav.archived')}
          onClick={() => setArchived((a) => !a)}
        >
          <ArchiveIcon />
        </button>
        <Menu
          label={t('nav.settings')}
          trigger={<DotsIcon />}
          placement="above"
          items={[
            { label: t('nav.workspace'), onSelect: () => navigate('/workspace/models') },
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
      {(title || action) && (
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-xs font-medium uppercase tracking-wide text-text-secondary">{title}</h2>
          {action}
        </div>
      )}
      <ul className="space-y-0.5">{children}</ul>
    </section>
  );
}

/** "Move to" entries: the top level and every folder, indented by depth. */
function moveTargets(
  tree: Tree,
  current: string | null,
  exclude: Set<string>,
  onMove: (folderId: string | null) => void,
  topLabel: string
): MenuItem[] {
  return [
    { label: topLabel, inset: true, disabled: current === null, onSelect: () => onMove(null) },
    ...tree.flat
      .filter(({ folder }) => !exclude.has(folder.id))
      .map(({ folder, depth }) => ({
        label: `${'  '.repeat(depth)}${folder.name}`,
        inset: true,
        disabled: current === folder.id,
        onSelect: () => onMove(folder.id),
      })),
  ];
}

function FolderItem({
  folder,
  tree,
  open,
  onToggle,
  onNewSubfolder,
  children,
}: {
  folder: Folder;
  tree: Tree;
  open: boolean;
  onToggle: () => void;
  onNewSubfolder: () => void;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [updateFolder] = useUpdateFolderMutation();
  const [deleteFolder] = useDeleteFolderMutation();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(folder.name);
  const [confirm, setConfirm] = useState(false);
  const [settings, setSettings] = useState(false);

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
            label={t('chat.folderActions')}
            trigger={<DotsIcon />}
            items={[
              { label: t('nav.newSubfolder'), onSelect: onNewSubfolder },
              { label: t('app.rename'), onSelect: () => setRenaming(true) },
              { label: t('folder.settings'), onSelect: () => setSettings(true) },
              'separator',
              { heading: t('chat.moveTo') },
              ...moveTargets(tree, folder.parentId, tree.within(folder.id), (parentId) => void updateFolder({ id: folder.id, parentId }), t('nav.topLevel')),
              'separator',
              { label: t('app.delete'), danger: true, onSelect: () => setConfirm(true) },
            ]}
          />
        </div>
      </div>
      {open && <ul className="ml-4 space-y-0.5 border-l border-border pl-1">{children}</ul>}
      {settings && <FolderSettings folder={folder} onClose={() => setSettings(false)} />}
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

/** A search snippet with the matched words highlighted. */
function Snippet({ text }: { text: string }) {
  const pieces = text.split(new RegExp(`(${SNIPPET_MARK_START}[^${SNIPPET_MARK_END}]*${SNIPPET_MARK_END})`));
  return (
    <span className="line-clamp-2 text-xs text-text-secondary" data-testid="search-snippet">
      {pieces.map((p, i) =>
        p.startsWith(SNIPPET_MARK_START) ? (
          <mark key={i} className="bg-transparent font-semibold text-accent">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </span>
  );
}

function ChatItem({ chat, tree, active }: { chat: ChatSummary; tree: Tree; active: boolean }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [updateChat] = useUpdateChatMutation();
  const [deleteChat] = useDeleteChatMutation();
  const [editing, setEditing] = useState<'title' | 'tags' | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const save = async () => {
    setError(null);
    if (editing === 'title') {
      if (value.trim() && value.trim() !== chat.title) await updateChat({ id: chat.id, title: value.trim() });
    } else if (editing === 'tags') {
      const tags = [...new Set(value.split(/[\s,]+/).map((x) => x.replace(/^#/, '').trim().toLowerCase()).filter(Boolean))];
      const res = await updateChat({ id: chat.id, tags });
      if ('error' in res) {
        setError((res.error as { message?: string }).message ?? t('app.error'));
        return;
      }
    }
    setEditing(null);
  };

  const items: Array<MenuItem | 'separator' | { heading: string }> = [
    {
      label: t('app.rename'),
      onSelect: () => {
        setValue(chat.title);
        setEditing('title');
      },
    },
    {
      label: t('chat.editTags'),
      onSelect: () => {
        setValue(chat.tags.join(' '));
        setEditing('tags');
      },
    },
    { label: chat.pinned ? t('chat.unpin') : t('chat.pin'), onSelect: () => void updateChat({ id: chat.id, pinned: !chat.pinned }) },
    {
      label: chat.archived ? t('chat.unarchive') : t('chat.archive'),
      onSelect: () => void updateChat({ id: chat.id, archived: !chat.archived }),
    },
    'separator',
    { heading: t('chat.moveTo') },
    ...moveTargets(tree, chat.folderId, new Set(), (folderId) => void updateChat({ id: chat.id, folderId }), t('chat.noFolder')),
    'separator',
    { label: t('app.delete'), danger: true, onSelect: () => setConfirm(true) },
  ];

  return (
    <li>
      <div className={`group flex items-center gap-1 rounded px-2 ${active ? 'bg-background font-medium' : 'hover:bg-background'}`}>
        {editing ? (
          <div className="my-1 min-w-0 flex-1">
            <input
              autoFocus
              className="w-full rounded border border-border bg-background px-1 py-0.5 outline-none focus:border-accent"
              value={value}
              aria-label={editing === 'title' ? t('app.rename') : t('chat.editTags')}
              placeholder={editing === 'tags' ? t('chat.tagsPlaceholder') : undefined}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                else if (e.key === 'Escape') setEditing(null);
              }}
              onBlur={() => (editing === 'tags' ? void save() : setEditing(null))}
            />
            {error && <p className="text-xs text-error">{error}</p>}
          </div>
        ) : (
          <NavLink to={`/c/${chat.id}`} className="flex min-w-0 flex-1 flex-col py-1.5" title={chat.title}>
            <span className="flex min-w-0 items-center gap-1.5">
              {chat.pinned && (
                <span className="shrink-0 text-text-secondary">
                  <PinIcon />
                </span>
              )}
              <span className="truncate">{chat.title}</span>
              {chat.tags.length > 0 && (
                <span className="ml-auto flex shrink-0 items-center text-text-secondary" title={chat.tags.map((x) => `#${x}`).join(' ')}>
                  <TagIcon />
                </span>
              )}
            </span>
            {chat.match && <Snippet text={chat.match.snippet} />}
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
