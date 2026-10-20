import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { errorMessage, useChannelsQuery, useCreateChannelMutation, usePermissions, useSessionQuery } from '../api/rtk-api';

const link = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded px-2 py-1.5 ${isActive ? 'bg-background font-medium text-text-primary' : 'text-text-secondary hover:bg-background hover:text-text-primary'}`;

/** Notes, scheduled prompts and channels, above the chat list. */
export function SidebarExtras() {
  const { t } = useTranslation();
  const permissions = usePermissions();
  const { data: session } = useSessionQuery();
  const { data } = useChannelsQuery();
  const [creating, setCreating] = useState(false);
  const isAdmin = session?.user?.role === 'admin';
  const channels = (data?.channels ?? []).filter((c) => !c.archived);

  return (
    <div className="px-2 pb-2 text-sm" data-testid="sidebar-extras">
      {permissions?.['features.notes'] && (
        <NavLink to="/notes" className={link}>
          <span aria-hidden>🗒</span> {t('notes.title')}
        </NavLink>
      )}
      {permissions?.['features.schedules'] && (
        <NavLink to="/schedules" className={link}>
          <span aria-hidden>⏰</span> {t('schedules.title')}
        </NavLink>
      )}
      {(channels.length > 0 || isAdmin) && (
        <div className="mt-2">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-xs font-medium uppercase tracking-wide text-text-secondary">{t('channels.title')}</h2>
            {isAdmin && (
              <button className="rounded px-1 text-text-secondary hover:text-accent" aria-label={t('channels.new')} onClick={() => setCreating(true)}>
                +
              </button>
            )}
          </div>
          <ul aria-label={t('channels.title')}>
            {channels.map((c) => (
              <li key={c.id}>
                <NavLink to={`/channels/${c.id}`} className={link}>
                  <span className="text-accent">#</span>
                  <span className="truncate">{c.name}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      {creating && <NewChannel onClose={() => setCreating(false)} />}
    </div>
  );
}

function NewChannel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [create, state] = useCreateChannelMutation();
  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('channels.new')}
      footer={
        <div className="flex items-center justify-end gap-2">
          {state.error && <span className="me-auto text-sm text-error">{errorMessage(state.error)}</span>}
          <Button variant="secondary" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <Button
            disabled={!name.trim() || state.isLoading}
            onClick={async () => {
              const res = await create({ name: name.trim(), description: description.trim() });
              if ('data' in res && res.data) {
                onClose();
                navigate(`/channels/${res.data.channel.id}`);
              }
            }}
          >
            {t('app.create')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('channels.name')}</span>
          <input className="w-full rounded border border-border bg-background px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('channels.description')}</span>
          <input className="w-full rounded border border-border bg-background px-2 py-1" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <p className="text-xs text-text-secondary">{t('channels.newHelp')}</p>
      </div>
    </Modal>
  );
}
