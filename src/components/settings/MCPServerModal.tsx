import React, { useState, useEffect } from 'react';
import { MCPServerConfig } from '../../types/mcp.types';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { v4 as uuidv4 } from 'uuid';

interface MCPServerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (config: MCPServerConfig) => void;
  initialConfig?: MCPServerConfig | null;
}

export function MCPServerModal({ isOpen, onClose, onSave, initialConfig }: MCPServerModalProps) {
  const isEditMode = !!initialConfig;

  // Form state
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([]);
  const [transport, setTransport] = useState<'stdio' | 'sse'>('stdio');
  const [description, setDescription] = useState('');

  // Validation errors
  const [errors, setErrors] = useState<{ name?: string; command?: string }>({});

  // Initialize form with initial config
  useEffect(() => {
    if (initialConfig) {
      setName(initialConfig.name);
      setCommand(initialConfig.command);
      setArgs(initialConfig.args.join('\n'));
      setEnvVars(
        Object.entries(initialConfig.env || {}).map(([key, value]) => ({ key, value }))
      );
      setTransport(initialConfig.transport);
      setDescription(initialConfig.metadata?.description || '');
    } else {
      // Reset form for add mode
      setName('');
      setCommand('');
      setArgs('');
      setEnvVars([]);
      setTransport('stdio');
      setDescription('');
    }
    setErrors({});
  }, [initialConfig, isOpen]);

  const validate = (): boolean => {
    const newErrors: { name?: string; command?: string } = {};

    if (!name.trim()) {
      newErrors.name = 'Server name is required';
    }

    if (!command.trim()) {
      newErrors.command = 'Command is required';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSave = () => {
    if (!validate()) {
      return;
    }

    const config: MCPServerConfig = {
      id: initialConfig?.id || uuidv4(),
      name: name.trim(),
      command: command.trim(),
      args: args
        .split('\n')
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0),
      env: envVars.reduce(
        (acc, { key, value }) => {
          if (key.trim()) {
            acc[key.trim()] = value;
          }
          return acc;
        },
        {} as Record<string, string>
      ),
      transport,
      enabled: initialConfig?.enabled ?? true,
      metadata: {
        description: description.trim() || undefined,
      },
    };

    onSave(config);
    onClose();
  };

  const handleAddEnvVar = () => {
    setEnvVars([...envVars, { key: '', value: '' }]);
  };

  const handleRemoveEnvVar = (index: number) => {
    setEnvVars(envVars.filter((_, i) => i !== index));
  };

  const handleEnvVarChange = (index: number, field: 'key' | 'value', value: string) => {
    const updated = [...envVars];
    updated[index][field] = value;
    setEnvVars(updated);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEditMode ? 'Edit MCP Server' : 'Add MCP Server'}
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave}>
            {isEditMode ? 'Save Changes' : 'Add Server'}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Server Name */}
        <div>
          <label className="mb-1 block text-sm font-medium text-text-primary">
            Server Name <span className="text-error">*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`w-full rounded border ${
              errors.name ? 'border-error' : 'border-border'
            } bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent`}
            placeholder="e.g., Filesystem Server"
          />
          {errors.name && <p className="mt-1 text-xs text-error">{errors.name}</p>}
        </div>

        {/* Command */}
        <div>
          <label className="mb-1 block text-sm font-medium text-text-primary">
            Command <span className="text-error">*</span>
          </label>
          <input
            type="text"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            className={`w-full rounded border ${
              errors.command ? 'border-error' : 'border-border'
            } bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent`}
            placeholder="e.g., npx or /path/to/executable"
          />
          {errors.command && <p className="mt-1 text-xs text-error">{errors.command}</p>}
          <p className="mt-1 text-xs text-text-secondary">
            The command to execute (e.g., "npx", "node", or full path to executable)
          </p>
        </div>

        {/* Arguments */}
        <div>
          <label className="mb-1 block text-sm font-medium text-text-primary">Arguments</label>
          <textarea
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            rows={3}
            className="w-full rounded border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="One argument per line, e.g.:&#10;-x&#10;@modelcontextprotocol/server-filesystem&#10;/path/to/data"
          />
          <p className="mt-1 text-xs text-text-secondary">
            Enter each argument on a separate line
          </p>
        </div>

        {/* Transport */}
        <div>
          <label className="mb-1 block text-sm font-medium text-text-primary">Transport</label>
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as 'stdio' | 'sse')}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="stdio">stdio (Standard Input/Output)</option>
            <option value="sse">SSE (Server-Sent Events)</option>
          </select>
          <p className="mt-1 text-xs text-text-secondary">
            Most MCP servers use stdio transport
          </p>
        </div>

        {/* Environment Variables */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="block text-sm font-medium text-text-primary">
              Environment Variables
            </label>
            <Button size="sm" variant="secondary" onClick={handleAddEnvVar}>
              + Add Variable
            </Button>
          </div>

          {envVars.length === 0 ? (
            <p className="rounded border border-border bg-surface p-3 text-center text-xs text-text-secondary">
              No environment variables configured. Click "Add Variable" to add one.
            </p>
          ) : (
            <div className="space-y-2">
              {envVars.map((envVar, index) => (
                <div key={index} className="flex gap-2">
                  <input
                    type="text"
                    value={envVar.key}
                    onChange={(e) => handleEnvVarChange(index, 'key', e.target.value)}
                    className="flex-1 rounded border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    placeholder="KEY"
                  />
                  <input
                    type="text"
                    value={envVar.value}
                    onChange={(e) => handleEnvVarChange(index, 'value', e.target.value)}
                    className="flex-1 rounded border border-border bg-surface px-3 py-2 font-mono text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
                    placeholder="value"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleRemoveEnvVar(index)}
                    className="text-error hover:bg-error hover:bg-opacity-10"
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Description */}
        <div>
          <label className="mb-1 block text-sm font-medium text-text-primary">
            Description (Optional)
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            placeholder="Describe what this server does..."
          />
        </div>
      </div>
    </Modal>
  );
}
