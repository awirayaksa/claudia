import { useState } from 'react';
import { useAppSelector } from '../../store';
import { useLoadSettingsFromStore } from '../../hooks/useLoadSettingsFromStore';

export function ProfilesSettings() {
  const { profiles, currentProfileId } = useAppSelector((state) => state.settings);
  const { reload } = useLoadSettingsFromStore();

  const [newName, setNewName] = useState('');
  const [cloneCurrent, setCloneCurrent] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const validateName = (name: string, excludeId?: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return 'Name cannot be empty.';
    if (profiles.some((p) => p.name === trimmed && p.id !== excludeId)) {
      return `A profile named "${trimmed}" already exists.`;
    }
    return null;
  };

  const handleCreate = async () => {
    const err = validateName(newName);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    try {
      await window.electron.profile.create({ name: newName.trim(), cloneCurrent });
      await reload();
      setNewName('');
      setCloneCurrent(true);
    } catch (e: any) {
      setError(e.message || 'Failed to create profile');
    }
  };

  const handleRename = async (id: string) => {
    const err = validateName(renameValue, id);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    try {
      await window.electron.profile.rename(id, renameValue.trim());
      await reload();
      setRenamingId(null);
      setRenameValue('');
    } catch (e: any) {
      setError(e.message || 'Failed to rename profile');
    }
  };

  const handleDuplicate = async (id: string) => {
    const source = profiles.find((p) => p.id === id);
    if (!source) return;
    let candidate = `${source.name} Copy`;
    let counter = 1;
    while (profiles.some((p) => p.name === candidate)) {
      counter++;
      candidate = `${source.name} Copy ${counter}`;
    }
    try {
      await window.electron.profile.duplicate(id, candidate);
      await reload();
    } catch (e: any) {
      setError(e.message || 'Failed to duplicate profile');
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await window.electron.profile.delete(id);
      await reload();
      setDeleteConfirm(null);
    } catch (e: any) {
      setError(e.message || 'Failed to delete profile');
    }
  };

  return (
    <div style={{ padding: '22px 28px' }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4, color: '#1a1a19' }}>Profiles</div>
        <div style={{ fontSize: 13, color: '#6f6b66', lineHeight: 1.55 }}>
          Each profile stores its own API, appearance, and preferences. MCP servers, plugins, and skills remain shared across all profiles.
        </div>
      </div>

      {/* Create profile */}
      <div style={{ border: '1px solid #ebe7e1', borderRadius: 10, padding: 16, marginBottom: 20, background: '#fff' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: '#2e2b27' }}>Create Profile</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 11.5, color: '#6f6b66', marginBottom: 4 }}>Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., Work, Personal"
              style={{
                width: '100%',
                border: '1px solid #ebe7e1',
                borderRadius: 7,
                padding: '7px 10px',
                fontSize: 13,
                background: '#fff',
                color: '#2e2b27',
                outline: 'none',
              }}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: '#2e2b27', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={cloneCurrent}
              onChange={(e) => setCloneCurrent(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            Clone current settings
          </label>
          <button
            onClick={handleCreate}
            style={{
              border: 'none',
              background: 'var(--color-accent, #c96a3d)',
              color: '#fff',
              borderRadius: 7,
              padding: '7px 14px',
              fontSize: 12.5,
              fontWeight: 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Create
          </button>
        </div>
        {error && <div style={{ fontSize: 12, color: '#b14a3b' }}>{error}</div>}
      </div>

      {/* Profiles list */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: '#2e2b27' }}>Your Profiles</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {profiles.map((profile) => (
            <div
              key={profile.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #ebe7e1',
                background: '#fff',
              }}
            >
              {renamingId === profile.id ? (
                <>
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRename(profile.id);
                      if (e.key === 'Escape') {
                        setRenamingId(null);
                        setRenameValue('');
                      }
                    }}
                    autoFocus
                    style={{
                      flex: 1,
                      border: '1px solid #ebe7e1',
                      borderRadius: 6,
                      padding: '5px 8px',
                      fontSize: 13,
                      outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => handleRename(profile.id)}
                    style={{
                      fontSize: 11.5,
                      padding: '4px 10px',
                      borderRadius: 5,
                      border: '1px solid #ebe7e1',
                      background: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setRenamingId(null);
                      setRenameValue('');
                    }}
                    style={{
                      fontSize: 11.5,
                      padding: '4px 10px',
                      borderRadius: 5,
                      border: '1px solid #ebe7e1',
                      background: '#fff',
                      cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, color: '#2e2b27' }}>{profile.name}</span>
                    {profile.id === currentProfileId && (
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: '#2f8f4a',
                          background: '#e8f5e9',
                          padding: '2px 6px',
                          borderRadius: 4,
                          textTransform: 'uppercase',
                        }}
                      >
                        Current
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {deleteConfirm === profile.id ? (
                      <>
                        <span style={{ fontSize: 11.5, color: '#b14a3b' }}>Confirm delete?</span>
                        <button
                          onClick={() => handleDelete(profile.id)}
                          style={{
                            fontSize: 11.5,
                            padding: '3px 8px',
                            borderRadius: 5,
                            border: '1px solid #b14a3b',
                            background: '#fff',
                            cursor: 'pointer',
                            color: '#b14a3b',
                          }}
                        >
                          Yes
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(null)}
                          style={{
                            fontSize: 11.5,
                            padding: '3px 8px',
                            borderRadius: 5,
                            border: '1px solid #ebe7e1',
                            background: '#fff',
                            cursor: 'pointer',
                            color: '#6f6b66',
                          }}
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => {
                            setRenamingId(profile.id);
                            setRenameValue(profile.name);
                          }}
                          style={{
                            fontSize: 11.5,
                            padding: '4px 10px',
                            borderRadius: 5,
                            border: '1px solid #ebe7e1',
                            background: '#fff',
                            cursor: 'pointer',
                            color: '#6f6b66',
                          }}
                        >
                          Rename
                        </button>
                        <button
                          onClick={() => handleDuplicate(profile.id)}
                          style={{
                            fontSize: 11.5,
                            padding: '4px 10px',
                            borderRadius: 5,
                            border: '1px solid #ebe7e1',
                            background: '#fff',
                            cursor: 'pointer',
                            color: '#6f6b66',
                          }}
                        >
                          Duplicate
                        </button>
                        <button
                          onClick={() => setDeleteConfirm(profile.id)}
                          disabled={profile.id === currentProfileId || profiles.length === 1}
                          style={{
                            fontSize: 11.5,
                            padding: '4px 10px',
                            borderRadius: 5,
                            border: '1px solid #ebe7e1',
                            background: '#fff',
                            cursor: profile.id === currentProfileId || profiles.length === 1 ? 'not-allowed' : 'pointer',
                            color: profile.id === currentProfileId || profiles.length === 1 ? '#b5b0a8' : '#6f6b66',
                          }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
