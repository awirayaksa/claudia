import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { ApiSettings } from './ApiSettings';
import { MCPSettings } from './MCPSettings';
import { ThemeSettings } from './ThemeSettings';
import { PluginSettings } from './PluginSettings';
import { PreferencesSettings } from './PreferencesSettings';
import { SkillSettings } from './SkillSettings';
import { useAppSelector, useAppDispatch } from '../../store';
import { setSettingsOpen } from '../../store/slices/uiSlice';

type TabId = 'api' | 'mcp' | 'plugins' | 'appearance' | 'preferences' | 'skills' | 'advanced';

interface SettingsContextValue {
  isDirty: boolean;
  setIsDirty: (dirty: boolean) => void;
  requestSave: () => void;
  registerSave: (fn: () => Promise<void>) => void;
}

export const SettingsContext = createContext<SettingsContextValue>({
  isDirty: false,
  setIsDirty: () => {},
  requestSave: () => {},
  registerSave: () => {},
});

export function useSettingsContext() {
  return useContext(SettingsContext);
}

const tabs: { id: TabId; label: string }[] = [
  { id: 'api', label: 'API Configuration' },
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'skills', label: 'Skills' },
  { id: 'advanced', label: 'Advanced' },
];

export function SettingsPanel() {
  const dispatch = useAppDispatch();
  const { settingsOpen } = useAppSelector((state) => state.ui);
  const [activeTab, setActiveTab] = useState<TabId>('api');
  const [isDirty, setIsDirty] = useState(false);
  const [saveRef, setSaveRef] = useState<(() => Promise<void>) | null>(null);

  const handleClose = useCallback(() => {
    dispatch(setSettingsOpen(false));
    setIsDirty(false);
  }, [dispatch]);

  const handleSave = async () => {
    if (saveRef) {
      await saveRef();
    }
    handleClose();
  };

  const registerSave = useCallback((fn: () => Promise<void>) => {
    setSaveRef(() => fn);
  }, []);

  const requestSave = useCallback(() => {
    saveRef?.();
  }, [saveRef]);

  // Reset dirty state when switching tabs
  const handleTabChange = (id: TabId) => {
    setActiveTab(id);
    setIsDirty(false);
    setSaveRef(null);
  };

  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [settingsOpen, handleClose]);

  if (!settingsOpen) return null;

  return (
    <SettingsContext.Provider value={{ isDirty, setIsDirty, requestSave, registerSave }}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }}
      >
        <div
          className="relative flex flex-col overflow-hidden rounded-xl shadow-2xl"
          style={{
            width: 820,
            height: 640,
            background: '#fdfcfa',
            border: '1px solid #ebe7e1',
            fontFamily: '"Inter", -apple-system, system-ui, sans-serif',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            style={{
              padding: '13px 20px',
              borderBottom: '1px solid #ebe7e1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: '#fff',
              flexShrink: 0,
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 600, color: '#1a1a19' }}>Settings</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: '#6f6b66' }}>Esc to close</span>
              <button
                onClick={handleClose}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 18,
                  color: '#2e2b27',
                  padding: '0 4px',
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          </div>

          {/* Body */}
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            {/* Sidebar */}
            <aside
              style={{
                width: 200,
                background: '#faf8f5',
                borderRight: '1px solid #ebe7e1',
                display: 'flex',
                flexDirection: 'column',
                flexShrink: 0,
              }}
            >
              {/* Search */}
              <div style={{ padding: '12px 12px 10px' }}>
                <div
                  style={{
                    border: '1px solid #ebe7e1',
                    background: '#fff',
                    borderRadius: 7,
                    padding: '6px 10px',
                    fontSize: 11.5,
                    color: '#6f6b66',
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                  }}
                >
                  <span>⌕</span>
                  <span style={{ flex: 1 }}>Search settings</span>
                  <span
                    style={{
                      fontSize: 10,
                      border: '1px solid #ebe7e1',
                      borderRadius: 3,
                      padding: '1px 4px',
                    }}
                  >
                    ⌘,
                  </span>
                </div>
              </div>

              {/* Nav items */}
              <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 8 }}>
                {tabs.map(({ id, label }) => {
                  const isActive = id === activeTab;
                  return (
                    <div
                      key={id}
                      onClick={() => handleTabChange(id)}
                      style={{
                        margin: '1px 6px',
                        padding: '8px 10px',
                        fontSize: 12.5,
                        cursor: 'pointer',
                        background: isActive ? '#f3ece4' : 'transparent',
                        borderLeft: isActive ? '2px solid #c96a3d' : '2px solid transparent',
                        borderRadius: 5,
                        color: '#2e2b27',
                        fontWeight: isActive ? 600 : 450,
                        transition: 'background 0.1s',
                      }}
                    >
                      {label}
                    </div>
                  );
                })}
              </div>

              {/* Version + Docs */}
              <div
                style={{
                  borderTop: '1px solid #ebe7e1',
                  padding: '10px 14px',
                  fontSize: 10.5,
                  color: '#6f6b66',
                  display: 'flex',
                  justifyContent: 'space-between',
                }}
              >
                <span>Claudia v0.8.1</span>
                <a
                  href="https://github.com/getclaudia/claudia"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#6f6b66', textDecoration: 'none', cursor: 'pointer' }}
                >
                  Docs ↗
                </a>
              </div>
            </aside>

            {/* Content */}
            <div style={{ flex: 1, overflowY: 'auto', background: '#fff', minWidth: 0 }}>
              {activeTab === 'api' && <ApiSettings />}
              {activeTab === 'mcp' && <MCPSettings />}
              {activeTab === 'plugins' && <PluginSettings />}
              {activeTab === 'appearance' && <ThemeSettings />}
              {activeTab === 'preferences' && <PreferencesSettings />}
              {activeTab === 'skills' && <SkillSettings />}
              {activeTab === 'advanced' && (
                <div style={{ padding: '22px 28px' }}>
                  <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Advanced</div>
                  <div style={{ fontSize: 13, color: '#6f6b66' }}>
                    Advanced configuration options coming soon.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              padding: '10px 20px',
              borderTop: '1px solid #ebe7e1',
              background: '#faf8f5',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <div
              style={{
                fontSize: 11.5,
                color: '#6f6b66',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                visibility: isDirty ? 'visible' : 'hidden',
              }}
            >
              <span style={{ color: '#c98a1f' }}>●</span> Unsaved changes
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={handleClose}
                style={{
                  border: '1px solid #ebe7e1',
                  background: '#fff',
                  borderRadius: 7,
                  padding: '6px 14px',
                  fontSize: 12.5,
                  cursor: 'pointer',
                  color: '#2e2b27',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                style={{
                  border: 'none',
                  background: '#1a1a19',
                  color: '#fff',
                  borderRadius: 7,
                  padding: '6px 14px',
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      </div>
    </SettingsContext.Provider>
  );
}
