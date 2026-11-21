import { describe, it, expect } from 'vitest';
import { defaultToolPolicy, toolPolicy, withToolPolicy } from './tool-policy';
import type { MCPServerConfig } from '../../types/mcp.types';

const builtin = { builtin: true };
const custom: MCPServerConfig = { id: 's', name: 'S', transport: 'stdio', command: 'x', enabled: true };

describe('tool policy', () => {
  it("allows a built-in server's read-only tools and asks for the rest", () => {
    for (const name of ['read_file', 'list_directory', 'get_file_info', 'search_files', 'read_range']) {
      expect(defaultToolPolicy(builtin, { name })).toBe('allow');
    }
    for (const name of ['write_file', 'move_file', 'edit_file', 'search_and_replace', 'create_directory']) {
      expect(defaultToolPolicy(builtin, { name })).toBe('ask');
    }
  });

  it("follows a built-in tool's read-only hint over its name", () => {
    expect(defaultToolPolicy(builtin, { name: 'azdo_list_projects', annotations: { readOnlyHint: true } })).toBe('allow');
    expect(defaultToolPolicy(builtin, { name: 'get_and_reset', annotations: { readOnlyHint: false } })).toBe('ask');
  });

  it("asks for every third-party tool, whatever it claims", () => {
    expect(defaultToolPolicy(custom, { name: 'read_file' })).toBe('ask');
    expect(defaultToolPolicy(custom, { name: 'lookup', annotations: { readOnlyHint: true } })).toBe('ask');
  });

  it('a saved policy wins, and saving the default stores nothing', () => {
    const allowed = withToolPolicy(custom, { name: 'write_file' }, 'allow');
    expect(allowed.toolPolicies).toEqual({ write_file: 'allow' });
    expect(toolPolicy(allowed, { name: 'write_file' })).toBe('allow');

    const blocked = withToolPolicy(allowed, { name: 'move_file' }, 'block');
    expect(blocked.toolPolicies).toEqual({ write_file: 'allow', move_file: 'block' });

    const reset = withToolPolicy(withToolPolicy(blocked, { name: 'write_file' }, 'ask'), { name: 'move_file' }, 'ask');
    expect(reset.toolPolicies).toBeUndefined();
  });
});
