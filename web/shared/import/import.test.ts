import { describe, it, expect } from 'vitest';
import { batchChats, convertImportFiles } from './index';
import { toIso, toTags } from './common';

const file = (name: string, data: unknown) => ({ name, text: JSON.stringify(data) });
const texts = (m: { parts: Array<{ type: string; text?: string }> }) =>
  m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('|');

describe('desktop conversations', () => {
  const project = { id: 'p1', name: 'Research', description: '', createdAt: '', updatedAt: '', settings: {} };
  const conv = {
    id: 'c1',
    projectId: 'p1',
    title: 'Weather',
    createdAt: '2025-03-01T10:00:00.000Z',
    updatedAt: '2025-03-01T10:05:00.000Z',
    model: 'gpt-4o',
    messageCount: 6,
    starred: true,
    messages: [
      { id: 'u1', role: 'user', content: 'Weather in Oslo?', timestamp: '2025-03-01T10:00:00.000Z', attachments: [{ name: 'map.png', mimeType: 'image/png', size: 10 }] },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: '2025-03-01T10:00:01.000Z',
        reasoning: 'Need a lookup',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'fetch', arguments: '{"url":"x"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      },
      { id: 'r1', role: 'tool', tool_call_id: 't1', content: 'Rain, 4°C', timestamp: '2025-03-01T10:00:02.000Z' },
      { id: 'a2', role: 'assistant', content: 'Rainy and 4°C.', timestamp: '2025-03-01T10:00:03.000Z', usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
      { id: 's1', role: 'system', content: 'Model changed', timestamp: '2025-03-01T10:00:04.000Z' },
      { id: 'u2', role: 'user', content: 'Thanks', timestamp: '2025-03-01T10:01:00.000Z', effort: 'high' },
      { id: 'a3', role: 'assistant', content: '', error: 'Rate limited', timestamp: '2025-03-01T10:01:01.000Z' },
    ],
  };

  it('turns each reply (tool rounds included) into one node, in the project folder', () => {
    const out = convertImportFiles([file('conversations/p1/c1.json', conv), file('projects/p1.json', project)]);
    expect(out.problems).toEqual([]);
    expect(out.counts.desktop).toBe(1);
    const [chat] = out.chats;
    expect(chat).toMatchObject({ title: 'Weather', folder: ['Research'], pinned: true, modelIds: ['gpt-4o'] });
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const reply = chat.messages[1];
    expect(reply.parts.map((p) => p.type)).toEqual(['reasoning', 'tool_call', 'tool_result', 'text']);
    expect(reply.usage).toMatchObject({ total_tokens: 37 });
    expect(reply.parentId).toBe(chat.messages[0].id);
    expect(chat.messages[0].parts[1]).toMatchObject({ type: 'file', fileId: '', name: 'map.png' });
    expect(chat.messages[2].effort).toBe('high');
    expect(chat.messages[3]).toMatchObject({ status: 'error', error: 'Rate limited' });
    expect(chat.currentLeafId).toBe(chat.messages[3].id);
  });

  it('names a project folder even without its project file', () => {
    expect(convertImportFiles([file('c1.json', conv)]).chats[0].folder).toEqual(['Imported project p1']);
    expect(convertImportFiles([file('c1.json', { ...conv, projectId: null })]).chats[0].folder).toBeNull();
  });
});

describe('Open WebUI exports', () => {
  const owui = [
    {
      id: 'x',
      title: 'Compare',
      created_at: 1735689600,
      updated_at: 1735689900,
      pinned: false,
      archived: true,
      meta: { tags: ['Work Stuff', 'q1'] },
      chat: {
        models: ['llama3', 'mistral'],
        history: {
          currentId: 'b2',
          messages: {
            u: { id: 'u', parentId: null, childrenIds: ['b1', 'b2'], role: 'user', content: 'Hi', timestamp: 1735689600, models: ['llama3', 'mistral'] },
            b1: { id: 'b1', parentId: 'u', childrenIds: [], role: 'assistant', content: 'Hello (llama)', model: 'llama3', timestamp: 1735689601, annotation: { rating: 1 } },
            b2: { id: 'b2', parentId: 'u', childrenIds: [], role: 'assistant', content: 'Hello (mistral)', model: 'mistral', timestamp: 1735689602 },
          },
        },
      },
    },
  ];

  it('keeps the tree, models, tags and the current branch', () => {
    const out = convertImportFiles([file('chat-export.json', owui)]);
    expect(out.counts.openwebui).toBe(1);
    const [chat] = out.chats;
    expect(chat).toMatchObject({ title: 'Compare', archived: true, tags: ['work-stuff', 'q1'], modelIds: ['llama3', 'mistral'] });
    expect(chat.createdAt).toBe('2025-01-01T00:00:00.000Z');
    expect(chat.messages.find((m) => m.id === 'u')!.models).toEqual(['llama3', 'mistral']);
    expect(chat.messages.filter((m) => m.parentId === 'u').map(texts)).toEqual(['Hello (llama)', 'Hello (mistral)']);
    expect(chat.messages.find((m) => m.id === 'b1')).toMatchObject({ rating: 1, modelId: 'llama3' });
    expect(chat.currentLeafId).toBe('b2');
  });

  it('imports a flat message list as one line', () => {
    const flat = [{ title: 'Old', chat: { messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] } }];
    const [chat] = convertImportFiles([file('old.json', flat)]).chats;
    expect(chat.messages.map((m) => [m.role, m.parentId])).toEqual([
      ['user', null],
      ['assistant', 'm0'],
    ]);
  });
});

describe('ChatGPT exports', () => {
  const gpt = [
    {
      title: 'Plot',
      create_time: 1700000000.5,
      update_time: 1700000100.25,
      current_node: 'a3',
      default_model_slug: 'gpt-4o',
      mapping: {
        root: { id: 'root', message: null, parent: null, children: ['sys'] },
        sys: {
          id: 'sys',
          parent: 'root',
          children: ['u1'],
          message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] }, metadata: { is_visually_hidden_from_conversation: true } },
        },
        u1: { id: 'u1', parent: 'sys', children: ['a1', 'b1'], message: { author: { role: 'user' }, create_time: 1700000001, content: { content_type: 'text', parts: ['Plot sin(x)'] } } },
        a1: {
          id: 'a1',
          parent: 'u1',
          children: ['t1'],
          message: { author: { role: 'assistant' }, content: { content_type: 'code', language: 'python', text: 'plot(sin)' }, metadata: { model_slug: 'gpt-4o' } },
        },
        t1: { id: 't1', parent: 'a1', children: ['a3'], message: { author: { role: 'tool' }, content: { content_type: 'execution_output', text: 'ok' } } },
        a3: { id: 'a3', parent: 't1', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Here is the plot.'] } } },
        b1: { id: 'b1', parent: 'u1', children: [], message: { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['Other version'] } } },
      },
    },
  ];

  it('skips hidden nodes, merges a reply continued after a tool step, keeps branches', () => {
    const out = convertImportFiles([file('conversations.json', gpt)]);
    expect(out.counts.chatgpt).toBe(1);
    const [chat] = out.chats;
    expect(chat.modelIds).toEqual(['gpt-4o']);
    expect(chat.messages.map((m) => m.id)).toEqual(['u1', 'a1', 'b1']);
    expect(chat.messages[0].parentId).toBeNull();
    expect(texts(chat.messages[1])).toBe('```python\nplot(sin)\n```|Here is the plot.');
    expect(chat.messages[2].parentId).toBe('u1');
    // The current node was merged into a1
    expect(chat.currentLeafId).toBe('a1');
    expect(chat.updatedAt).toBe('2023-11-14T22:15:00.250Z');
  });
});

describe('Claudia exports and problems', () => {
  it('reads Claudia exports and reports files it does not know', () => {
    const exported = {
      format: 'claudia-web',
      version: 1,
      exportedAt: '2025-01-01T00:00:00Z',
      chats: [
        {
          title: 'Mine',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z',
          currentLeafId: 'a',
          messages: [{ id: 'a', parentId: null, role: 'user', parts: [{ type: 'text', text: 'x' }], createdAt: '2025-01-01T00:00:00Z' }],
        },
      ],
    };
    const out = convertImportFiles([file('mine.json', exported), { name: 'notes.txt', text: 'hello' }, file('other.json', { foo: 1 })]);
    expect(out.counts.claudia).toBe(1);
    expect(out.problems.map((p) => p.file)).toEqual(['notes.txt', 'other.json']);
  });

  it('splits large imports into batches', () => {
    const chat = (n: number) => ({
      title: `c${n}`,
      createdAt: '',
      updatedAt: '',
      modelIds: [],
      params: {},
      tags: [],
      pinned: false,
      archived: false,
      folder: null,
      currentLeafId: null,
      messages: [{ id: 'a', parentId: null, role: 'user' as const, parts: [{ type: 'text' as const, text: 'x'.repeat(1000) }], status: 'completed' as const, createdAt: '' }],
    });
    const chats = Array.from({ length: 10 }, (_, i) => chat(i));
    expect(batchChats(chats, 3000).map((b) => b.length)).toEqual([2, 2, 2, 2, 2]);
    expect(batchChats(chats, 1e9, 4).map((b) => b.length)).toEqual([4, 4, 2]);
  });

  it('reads timestamps in any unit and normalizes tags', () => {
    const iso = '2025-01-01T00:00:00.000Z';
    expect([toIso(1735689600, ''), toIso(1735689600000, ''), toIso(1735689600000000000, ''), toIso(iso, '')]).toEqual([iso, iso, iso, iso]);
    expect(toIso('nonsense', 'fallback')).toBe('fallback');
    expect(toTags(['A B', { name: 'Deep' }, 'a-b', '', 7])).toEqual(['a-b', 'deep']);
  });
});
