import { describe, it, expect } from 'vitest';
import {
  TOOL_NAME_PATTERN,
  aliasesToOpenAI,
  buildToolAliases,
  cleanJsonSchema,
  isUIResource,
  normalizeToolResult,
  resolveToolAlias,
  sanitizeToolName,
  shortHash,
} from './tool-format';
import type { MCPTool } from '../../types/mcp.types';

const t = (name: string): MCPTool => ({ name, inputSchema: { type: 'object', properties: {} } });

describe('sanitizeToolName', () => {
  it('replaces characters OpenAI rejects', () => {
    expect(sanitizeToolName('files.read')).toBe('files_read');
    expect(sanitizeToolName('read file / now')).toBe('read_file_now');
    expect(sanitizeToolName('ok-name_1')).toBe('ok-name_1');
    expect(sanitizeToolName('...')).toBe('tool');
  });
});

describe('shortHash', () => {
  it('is deterministic 8-char hex', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'));
    expect(shortHash('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(shortHash('abc')).not.toBe(shortHash('abd'));
  });
});

describe('buildToolAliases', () => {
  it('keeps bare names when they are unique', () => {
    const aliases = buildToolAliases([
      { id: 'a', name: 'Filesystem', tools: [t('read_file'), t('write_file')] },
      { id: 'b', name: 'Fetch', tools: [t('fetch')] },
    ]);
    expect(aliases.map((a) => a.alias)).toEqual(['read_file', 'write_file', 'fetch']);
    expect(aliases[2]).toMatchObject({ serverId: 'b', tool: 'fetch' });
  });

  it('prefixes only the colliding tools with a server alias', () => {
    const aliases = buildToolAliases([
      { id: 'a', name: 'Web Search', tools: [t('search'), t('open')] },
      { id: 'b', name: 'Docs', tools: [t('search')] },
    ]);
    expect(aliases.map((a) => a.alias)).toEqual(['web_search__search', 'open', 'docs__search']);
    expect(resolveToolAlias('docs__search', aliases)).toMatchObject({ serverId: 'b', tool: 'search' });
  });

  it('disambiguates servers whose names give the same prefix', () => {
    const aliases = buildToolAliases([
      { id: 'one', name: 'Tools', tools: [t('run')] },
      { id: 'two', name: 'tools', tools: [t('run')] },
    ]);
    const [a, b] = aliases.map((x) => x.alias);
    expect(a).not.toBe(b);
    expect(a.startsWith('tools_')).toBe(true);
    expect(b.startsWith('tools_')).toBe(true);
  });

  it('sanitizes real names but keeps them for the call', () => {
    const aliases = buildToolAliases([{ id: 'a', name: 'X', tools: [t('files.read')] }]);
    expect(aliases[0]).toMatchObject({ alias: 'files_read', tool: 'files.read' });
  });

  it('separates names that only collide after sanitizing', () => {
    const aliases = buildToolAliases([{ id: 'a', name: 'X', tools: [t('a.b'), t('a_b')] }]);
    expect(new Set(aliases.map((a) => a.alias)).size).toBe(2);
    expect(aliases.map((a) => a.tool)).toEqual(['a.b', 'a_b']);
  });

  it('hash-truncates names over 64 characters and every alias matches the OpenAI pattern', () => {
    const long = 'x'.repeat(80);
    const aliases = buildToolAliases([
      { id: 'a', name: 'A server with a very long display name', tools: [t(long), t('dup')] },
      { id: 'b', name: 'Another server with a long name', tools: [t(long), t('dup')] },
    ]);
    for (const a of aliases) {
      expect(a.alias).toMatch(TOOL_NAME_PATTERN);
    }
    expect(new Set(aliases.map((a) => a.alias)).size).toBe(aliases.length);
  });

  it('is stable for the same input', () => {
    const servers = [
      { id: 'a', name: 'A', tools: [t('x')] },
      { id: 'b', name: 'B', tools: [t('x')] },
    ];
    expect(buildToolAliases(servers)).toEqual(buildToolAliases(servers));
  });
});

describe('cleanJsonSchema / aliasesToOpenAI', () => {
  it('strips $schema and additionalProperties recursively', () => {
    expect(
      cleanJsonSchema({
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        properties: { a: { type: 'object', additionalProperties: true, properties: {} } },
        anyOf: [{ $schema: 'x', type: 'string' }],
      })
    ).toEqual({
      type: 'object',
      properties: { a: { type: 'object', properties: {} } },
      anyOf: [{ type: 'string' }],
    });
  });

  it('names OpenAI functions by alias', () => {
    const aliases = buildToolAliases([
      { id: 'a', name: 'A', tools: [{ ...t('x'), description: 'does x' }] },
      { id: 'b', name: 'B', tools: [t('x')] },
    ]);
    expect(aliasesToOpenAI(aliases)).toEqual([
      { type: 'function', function: { name: 'a__x', description: 'does x', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'b__x', description: '', parameters: { type: 'object', properties: {} } } },
    ]);
  });
});

describe('normalizeToolResult', () => {
  it('joins text, images and resources as text for the model', () => {
    expect(
      normalizeToolResult({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'image', mimeType: 'image/png', data: 'AA' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'file body' } },
          { type: 'resource', resource: { uri: 'file:///b.bin' } },
          { type: 'audio', data: 'x' },
        ],
      })
    ).toEqual({
      content: 'line 1\n[Image: image/png]\nfile body\n[Resource: file:///b.bin]\n{"type":"audio","data":"x"}',
      isError: false,
    });
  });

  it('keeps a UI resource for rendering and gives the model only the text', () => {
    const ui = { uri: 'ui://chart/1', mimeType: 'text/html' as const, text: '<div/>' };
    expect(normalizeToolResult({ content: [{ type: 'resource', resource: ui }, { type: 'text', text: 'Chart ready' }] })).toEqual({
      content: 'Chart ready',
      isError: false,
      uiResource: ui,
    });
    expect(normalizeToolResult({ content: [{ type: 'resource', resource: ui }] }).content).toBe('[Interactive UI: ui://chart/1]');
  });

  it('reports errors with their text', () => {
    expect(normalizeToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }, { type: 'x' }] })).toEqual({
      content: 'boom\n{"type":"x"}',
      isError: true,
    });
  });

  it('copes with a missing content array', () => {
    expect(normalizeToolResult({})).toEqual({ content: '', isError: false });
  });

  it('matches @mcp-ui/client on what counts as a UI resource', () => {
    expect(isUIResource({ type: 'resource', resource: { uri: 'ui://x' } })).toBe(true);
    expect(isUIResource({ type: 'resource', resource: { uri: 'https://x' } })).toBe(false);
    expect(isUIResource({ type: 'text', text: 'ui://x' })).toBe(false);
    expect(isUIResource(null)).toBe(false);
  });
});
