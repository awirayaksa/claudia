import { useState } from 'react';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { ApiSettings } from './APISettings';
import { MCPSettings } from './MCPSettings';
import { ThemeSettings } from './ThemeSettings';
import { PluginSettings } from './PluginSettings';
import { useAppSelector, useAppDispatch } from '../../store';
import { setSettingsOpen } from '../../store/slices/uiSlice';

export function SettingsPanel() {
  const dispatch = useAppDispatch();
  const { settingsOpen } = useAppSelector((state) => state.ui);
  const [activeTab, setActiveTab] = useState<'api' | 'mcp' | 'plugins' | 'appearance' | 'preferences'>('api');

  const handleClose = () => {
    dispatch(setSettingsOpen(false));
  };

  const tabs = [
    { id: 'api' as const, label: 'API Configuration' },
    { id: 'mcp' as const, label: 'MCP Servers' },
    { id: 'plugins' as const, label: 'Plugins' },
    { id: 'appearance' as const, label: 'Appearance' },
    { id: 'preferences' as const, label: 'Preferences' },
  ];

  return (
    <Modal
      isOpen={settingsOpen}
      onClose={handleClose}
      title="Settings"
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="flex h-[500px]">
        {/* Tabs sidebar */}
        <div className="w-48 border-r border-border pr-4">
          <nav className="space-y-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                  activeTab === tab.id
                    ? 'bg-accent text-white'
                    : 'text-text-primary hover:bg-surface'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Tab content */}
        <div className="flex-1 pl-6 overflow-y-auto">
          {activeTab === 'api' && <ApiSettings />}
          {activeTab === 'mcp' && <MCPSettings />}
          {activeTab === 'plugins' && <PluginSettings />}
          {activeTab === 'appearance' && <ThemeSettings />}
          {activeTab === 'preferences' && (
            <div className="text-text-secondary">
              <p>Additional preferences coming soon...</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
