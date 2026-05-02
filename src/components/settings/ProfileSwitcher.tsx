import { useState, useRef, useEffect } from 'react';
import { useAppSelector } from '../../store';
import { useSettingsContext } from './SettingsPanel';
import { useLoadSettingsFromStore } from '../../hooks/useLoadSettingsFromStore';

interface ProfileSwitcherProps {
  onOpenProfilesTab: () => void;
}

export function ProfileSwitcher({ onOpenProfilesTab }: ProfileSwitcherProps) {
  const { profiles, currentProfileId } = useAppSelector((state) => state.settings);
  const { isDirty, setIsDirty } = useSettingsContext();
  const { reload } = useLoadSettingsFromStore();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeProfile = profiles.find((p) => p.id === currentProfileId);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSwitch = async (id: string) => {
    if (id === currentProfileId) {
      setOpen(false);
      return;
    }
    if (isDirty) {
      const confirmed = window.confirm('You have unsaved changes. Are you sure you want to discard them?');
      if (!confirmed) {
        setOpen(false);
        return;
      }
    }
    setOpen(false);
    try {
      await window.electron.profile.switch(id);
      await reload();
      setIsDirty(false);
    } catch (error) {
      console.error('Failed to switch profile:', error);
    }
  };

  return (
    <div ref={dropdownRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 6,
          border: '1px solid #ebe7e1',
          background: '#fff',
          fontSize: 12.5,
          color: '#2e2b27',
          cursor: 'pointer',
        }}
      >
        <span>{activeProfile?.name || 'Default'}</span>
        <span style={{ fontSize: 10 }}>▼</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            minWidth: 180,
            background: '#fff',
            border: '1px solid #ebe7e1',
            borderRadius: 8,
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            zIndex: 100,
            padding: '4px 0',
          }}
        >
          {profiles.map((profile) => (
            <div
              key={profile.id}
              onClick={() => handleSwitch(profile.id)}
              style={{
                padding: '6px 12px',
                fontSize: 12.5,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: profile.id === currentProfileId ? '#f3ece4' : 'transparent',
              }}
            >
              <span>{profile.name}</span>
              {profile.id === currentProfileId && <span>✓</span>}
            </div>
          ))}
          <div style={{ borderTop: '1px solid #ebe7e1', margin: '4px 0' }} />
          <div
            onClick={() => {
              setOpen(false);
              onOpenProfilesTab();
            }}
            style={{
              padding: '6px 12px',
              fontSize: 12.5,
              cursor: 'pointer',
              color: '#6f6b66',
            }}
          >
            + New profile…
          </div>
        </div>
      )}
    </div>
  );
}
