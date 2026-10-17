import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const handlers = new Map<string, (...args: any[]) => any>();
let userData = '';

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn) },
}));

const { registerConversationHandlers } = await import('./conversation.handler');

const invoke = (channel: string, ...args: any[]) => handlers.get(channel)!({}, ...args);

const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  projectId: null,
  title: 'New Conversation',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  model: 'model-a',
  messages: [{ id: 'm1', role: 'user', content: 'hi' }],
  messageCount: 1,
  ...overrides,
});

beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'claudia-conv-'));
  handlers.clear();
  registerConversationHandlers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

describe('conversation handlers', () => {
  it('updateMeta patches title, model and starred without touching messages', async () => {
    await invoke('conversation:save', conversation());

    const res = await invoke('conversation:updateMeta', 'c1', null, { title: 'Trip plan', starred: true });

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ id: 'c1', title: 'Trip plan', starred: true, model: 'model-a', messageCount: 1 });
    const loaded = (await invoke('conversation:load', 'c1', null)).data;
    expect(loaded.title).toBe('Trip plan');
    expect(loaded.messages).toEqual([{ id: 'm1', role: 'user', content: 'hi' }]);
  });

  it('a late autosave with a stale title keeps the title already on disk', async () => {
    await invoke('conversation:save', conversation());
    // AI title lands...
    await invoke('conversation:updateMeta', 'c1', null, { title: 'Trip plan', model: 'model-b' });
    // ...then an autosave captured before it writes new messages
    const res = await invoke(
      'conversation:save',
      conversation({
        messages: [
          { id: 'm1', role: 'user', content: 'hi' },
          { id: 'm2', role: 'assistant', content: 'hello' },
        ],
        messageCount: 2,
      })
    );

    expect(res.data).toMatchObject({ title: 'Trip plan', model: 'model-b', messageCount: 2 });
    const loaded = (await invoke('conversation:load', 'c1', null)).data;
    expect(loaded.title).toBe('Trip plan');
    expect(loaded.model).toBe('model-b');
    expect(loaded.messages).toHaveLength(2);
  });

  it('a first save stores the given title', async () => {
    const res = await invoke('conversation:save', conversation({ id: 'c2', title: 'Branched from X' }));
    expect(res.data.title).toBe('Branched from X');
  });

  it('updateMeta reports a missing conversation', async () => {
    const res = await invoke('conversation:updateMeta', 'nope', null, { title: 'x' });
    expect(res).toEqual({ success: false, error: 'Conversation not found' });
  });

  it('works for conversations inside a project folder', async () => {
    await invoke('conversation:save', conversation({ id: 'p1', projectId: 'proj' }));
    await invoke('conversation:updateMeta', 'p1', 'proj', { title: 'In project' });
    const list = (await invoke('conversation:list', 'proj')).data;
    expect(list).toEqual([expect.objectContaining({ id: 'p1', title: 'In project', projectId: 'proj' })]);
  });
});
