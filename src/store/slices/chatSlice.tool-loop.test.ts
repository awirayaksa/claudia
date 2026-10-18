/**
 * Characterization tests for the desktop tool loop
 * (`sendStreamingMessageWithTools`): request shapes per iteration, stored
 * message records, tool execution, aborts and the iteration cap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  makeChatStore,
  readyServer,
  scriptedProvider,
  stubPlatform,
  textResult,
  tool,
} from '../../test/chat-harness';

const providerRef: { current: any } = { current: null };
vi.mock('../../services/api/provider.service', () => ({
  getAPIProvider: () => providerRef.current,
}));

// Imported after the mock is registered
const { sendStreamingMessageWithTools, abortStreaming } = await import('./chatSlice');

const readFileCall = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('sendStreamingMessageWithTools', () => {
  it('runs one tool round and stores the flat assistant/tool/assistant records', async () => {
    const { provider, requests } = scriptedProvider([
      { reasoning: 'need file', text: 'Let me look.', toolCalls: [readFileCall] },
      { text: 'The file says hi.', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
    ]);
    providerRef.current = provider;
    const electron = stubPlatform(async () => textResult('hi'));
    const store = makeChatStore([readyServer('fs', 'Filesystem', [tool('read_file', 'Read a file')])]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'What is in a.txt?', model: 'm' }) as any);

    // Tool executed on the server that owns it
    expect(electron.mcp.callTool).toHaveBeenCalledWith('fs', 'read_file', { path: 'a.txt' }, undefined);

    // Request 1: tools offered
    expect(requests).toHaveLength(2);
    expect(requests[0].tool_choice).toBe('auto');
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['read_file']);
    expect(requests[0].messages).toEqual([{ role: 'user', content: 'What is in a.txt?' }]);

    // Request 2 offers tools again, so the model can chain another call
    expect(requests[1].tool_choice).toBe('auto');
    expect(requests[1].tools?.map((t) => t.function.name)).toEqual(['read_file']);

    // ...and carries the tool round as assistant(tool_calls) → tool
    expect(requests[1].messages).toEqual([
      { role: 'user', content: 'What is in a.txt?' },
      { role: 'assistant', tool_calls: [readFileCall], reasoning_content: 'need file' },
      { role: 'tool', content: 'hi', tool_call_id: 'call_1' },
    ]);

    const { messages, error, isStreaming } = store.getState().chat;
    expect(error).toBeNull();
    expect(isStreaming).toBe(false);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(messages[1]).toMatchObject({
      content: 'Let me look.',
      reasoning: 'need file',
      toolCalls: [readFileCall],
      toolResults: [{ tool_call_id: 'call_1', name: 'read_file', content: 'hi', isError: false }],
    });
    expect(messages[2]).toMatchObject({ role: 'tool', content: 'hi', tool_call_id: 'call_1', name: 'read_file' });
    expect(messages[3]).toMatchObject({
      role: 'assistant',
      content: 'The file says hi.',
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
  });

  it('offers tools only on the first request when the provider is toolsFirstTurnOnly', async () => {
    const { provider, requests } = scriptedProvider([{ toolCalls: [readFileCall] }, { text: 'done' }], {
      toolsFirstTurnOnly: true,
    });
    providerRef.current = provider;
    stubPlatform(async () => textResult('hi'));
    const store = makeChatStore([readyServer('fs', 'Filesystem', [tool('read_file')])]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    expect(requests[0].tool_choice).toBe('auto');
    expect(requests[0].tools).toHaveLength(1);
    expect(requests[1].tool_choice).toBe('none');
    expect(requests[1].tools).toBeUndefined();
  });

  it('keeps same-named tools from two servers apart and routes each call to its server', async () => {
    const { provider, requests } = scriptedProvider([
      {
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'web__search', arguments: '{"q":"a"}' } },
          { id: 'c2', type: 'function', function: { name: 'docs__search', arguments: '{"q":"b"}' } },
          { id: 'c3', type: 'function', function: { name: 'fetch', arguments: '{}' } },
        ],
      },
      { text: 'done' },
    ]);
    providerRef.current = provider;
    const electron = stubPlatform(async (serverId: string) => textResult(`from ${serverId}`));
    const store = makeChatStore([
      readyServer('s-web', 'Web', [tool('search'), tool('fetch')]),
      readyServer('s-docs', 'Docs', [tool('search')]),
    ]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['web__search', 'fetch', 'docs__search']);
    expect(electron.mcp.callTool.mock.calls.map((c: any[]) => [c[0], c[1]])).toEqual([
      ['s-web', 'search'],
      ['s-docs', 'search'],
      ['s-web', 'fetch'],
    ]);
    const results = store.getState().chat.messages[1].toolResults!;
    expect(results.map((r) => [r.name, r.serverId, r.content])).toEqual([
      ['search', 's-web', 'from s-web'],
      ['search', 's-docs', 'from s-docs'],
      ['fetch', 's-web', 'from s-web'],
    ]);
  });

  it('still resolves a bare tool name from older history', async () => {
    const { provider } = scriptedProvider([
      { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { text: 'done' },
    ]);
    providerRef.current = provider;
    const electron = stubPlatform(async () => textResult('ok'));
    const store = makeChatStore([
      readyServer('s-web', 'Web', [tool('search')]),
      readyServer('s-docs', 'Docs', [tool('search')]),
    ]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    // First ready server that offers it, as before
    expect(electron.mcp.callTool).toHaveBeenCalledWith('s-web', 'search', {}, undefined);
  });

  it('prepends the global system prompt and then the skill prompt', async () => {
    const { provider, requests } = scriptedProvider([{ text: 'ok' }]);
    providerRef.current = provider;
    stubPlatform(async () => textResult(''));
    const store = makeChatStore();
    store.dispatch({ type: 'settings/setPreferences', payload: { systemPrompt: 'GLOBAL' } });

    await store.dispatch(
      sendStreamingMessageWithTools({ content: 'hi', model: 'm', skillPrompt: 'SKILL' }) as any
    );

    expect(requests[0].messages.slice(0, 2)).toEqual([
      expect.objectContaining({ role: 'system', content: 'GLOBAL' }),
      expect.objectContaining({ role: 'system', content: 'SKILL' }),
    ]);
    // No tools: tool_choice is 'none' and tools are omitted
    expect(requests[0].tools).toBeUndefined();
    expect(requests[0].tool_choice).toBe('none');
  });

  it('reports a tool that no ready server provides as an error result', async () => {
    const { provider, requests } = scriptedProvider([
      { toolCalls: [{ ...readFileCall, function: { name: 'missing_tool', arguments: '{}' } }] },
      { text: 'sorry' },
    ]);
    providerRef.current = provider;
    const electron = stubPlatform(async () => textResult('never'));
    const store = makeChatStore([readyServer('fs', 'Filesystem', [tool('read_file')])]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    expect(electron.mcp.callTool).not.toHaveBeenCalled();
    const toolMsg = requests[1].messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('Tool \\"missing_tool\\" not found');
  });

  it('sends a short confirmation instead of UI resource content', async () => {
    const { provider, requests } = scriptedProvider([{ toolCalls: [readFileCall] }, { text: 'shown' }]);
    providerRef.current = provider;
    stubPlatform(async () => ({
      success: true,
      result: {
        content: [{ type: 'resource', resource: { uri: 'ui://widget/1', mimeType: 'text/html', text: '<b>x</b>' } }],
      },
    }));
    const store = makeChatStore([readyServer('fs', 'Filesystem', [tool('read_file')])]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    const toolMsg = requests[1].messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toBe(
      'Interactive UI component displayed successfully. The user can now interact with the read_file interface.'
    );
    const stored = store.getState().chat.messages.find((m) => m.role === 'tool')!;
    expect(stored.toolResults?.[0]).toMatchObject({ hasUI: true, uiResource: { uri: 'ui://widget/1' } });
  });

  it('stops after the iteration cap and sets an error', async () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      toolCalls: [{ ...readFileCall, id: `call_${i}` }],
    }));
    const { provider, requests } = scriptedProvider(turns);
    providerRef.current = provider;
    stubPlatform(async () => textResult('again'));
    const store = makeChatStore([readyServer('fs', 'Filesystem', [tool('read_file')])]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'loop', model: 'm' }) as any);

    expect(requests).toHaveLength(5);
    expect(store.getState().chat.error).toBe('Maximum tool calling iterations reached');
    expect(store.getState().chat.isStreaming).toBe(false);
  });

  it('stops after the running tools when the user aborts during tool execution', async () => {
    const { provider, requests } = scriptedProvider([{ toolCalls: [readFileCall] }, { text: 'never sent' }]);
    providerRef.current = provider;
    const store = makeChatStore([readyServer('fs', 'Filesystem', [tool('read_file')])]);
    // The user presses Stop while the tool is running
    stubPlatform(async () => {
      store.dispatch(abortStreaming());
      return textResult('late');
    });

    await store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    expect(requests).toHaveLength(1);
    expect(store.getState().chat.error).toBeNull();
    expect(store.getState().chat.isStreaming).toBe(false);
    // The tool round that already ran is kept
    expect(store.getState().chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('sends Open WebUI file ids from the whole conversation, and only to Open WebUI', async () => {
    const pdf = { id: 'a1', type: 'file' as const, name: 'a.pdf', size: 1, mimeType: 'application/pdf', remoteFileId: 'file-1' };
    const doc = { id: 'a2', type: 'file' as const, name: 'b.docx', size: 1, mimeType: 'x', remoteFileId: 'file-2' };

    const owui = scriptedProvider([{ text: 'one' }, { text: 'two' }]);
    owui.provider.getProviderType = () => 'openwebui' as any;
    providerRef.current = owui.provider;
    stubPlatform(async () => textResult(''));
    const store = makeChatStore();

    await store.dispatch(sendStreamingMessageWithTools({ content: 'read', model: 'm', attachments: [pdf] }) as any);
    await store.dispatch(sendStreamingMessageWithTools({ content: 'and this', model: 'm', attachments: [doc] }) as any);

    expect(owui.requests[0].files).toEqual([{ type: 'file', id: 'file-1' }]);
    expect(owui.requests[1].files).toEqual([
      { type: 'file', id: 'file-1' },
      { type: 'file', id: 'file-2' },
    ]);

    const other = scriptedProvider([{ text: 'x' }]);
    providerRef.current = other.provider;
    await makeChatStore().dispatch(
      sendStreamingMessageWithTools({ content: 'read', model: 'm', attachments: [pdf] }) as any
    );
    expect(other.requests[0].files).toBeUndefined();
  });

  it('inlines extracted attachment text in the user message', async () => {
    const { provider, requests } = scriptedProvider([{ text: 'ok' }]);
    providerRef.current = provider;
    stubPlatform(async () => textResult(''));
    const store = makeChatStore();

    await store.dispatch(
      sendStreamingMessageWithTools({
        content: 'Summarize',
        model: 'm',
        attachments: [{ id: 'a', type: 'file', name: 'r.pdf', size: 1, mimeType: 'application/pdf', extractedText: 'Body' }],
      }) as any
    );

    expect(requests[0].messages[0]).toEqual({
      role: 'user',
      content: 'Summarize\n\n<attachment name="r.pdf">\nBody\n</attachment>',
    });
    // The stored message keeps the user's own text; the attachment carries the document
    expect(store.getState().chat.messages[0].content).toBe('Summarize');
  });

  it('surfaces a provider error and rejects', async () => {
    const { provider } = scriptedProvider([{ error: new Error('HTTP 500') }]);
    providerRef.current = provider;
    stubPlatform(async () => textResult(''));
    const store = makeChatStore();

    const result: any = await store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    expect(result.meta.requestStatus).toBe('rejected');
    expect(store.getState().chat.error).toBe('HTTP 500');
  });
});
