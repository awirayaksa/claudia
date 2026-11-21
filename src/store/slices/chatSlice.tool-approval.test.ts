/**
 * Desktop tool permissions in the tool loop: tools that ask wait for Allow
 * once / Always allow / Deny, blocked tools are never offered or run, and
 * Stop or clearing the chat releases calls still waiting.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeChatStore, readyServer, scriptedProvider, stubPlatform, textResult, tool } from '../../test/chat-harness';
import type { ToolCall } from '../../types/message.types';
import type { MCPServerState } from '../../types/mcp.types';

const providerRef: { current: any } = { current: null };
vi.mock('../../services/api/provider.service', () => ({
  getAPIProvider: () => providerRef.current,
}));

// Imported after the mock is registered
const { sendStreamingMessageWithTools, answerToolApproval, abortStreaming, clearMessages } = await import('./chatSlice');

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

/** A third-party server whose tools all ask (no saved policies). */
const askingServer = (): MCPServerState => readyServer('fs', 'Files', [tool('write_file'), tool('delete_file')], {});

function setup(server: MCPServerState, turns: Parameters<typeof scriptedProvider>[0]) {
  const { provider, requests } = scriptedProvider(turns);
  providerRef.current = provider;
  const electron = stubPlatform(async (_server: string, name: string) => textResult(`${name} done`));
  const saveConfig = vi.fn(async () => ({ success: true }));
  (electron.mcp as any).saveConfig = saveConfig;
  const store = makeChatStore([server]);
  return { store, requests, callTool: electron.mcp.callTool, saveConfig };
}

/** Wait until these calls wait for the user. */
async function waitingFor(store: ReturnType<typeof makeChatStore>, ids: string[]) {
  await vi.waitFor(() => expect(store.getState().chat.awaitingApproval).toEqual(ids));
}

const toolCallsOf = (store: ReturnType<typeof makeChatStore>) => store.getState().chat.messages.flatMap((m) => m.toolCalls ?? []);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('tool permissions (desktop)', () => {
  it('waits for approval; Deny skips the tool and the model continues', async () => {
    const { store, requests, callTool } = setup(askingServer(), [
      { toolCalls: [call('c1', 'write_file', { path: 'a.txt', content: 'hi' })] },
      { text: 'Okay, I did not write it.' },
    ]);
    const run = store.dispatch(sendStreamingMessageWithTools({ content: 'write a.txt', model: 'm' }) as any);

    await waitingFor(store, ['c1']);
    expect(toolCallsOf(store)[0].approval).toBe('pending');
    expect(callTool).not.toHaveBeenCalled();

    await store.dispatch(answerToolApproval({ callId: 'c1', decision: 'deny' }) as any);
    await run;

    expect(callTool).not.toHaveBeenCalled();
    expect(toolCallsOf(store)[0].approval).toBe('rejected');
    expect(store.getState().chat.awaitingApproval).toEqual([]);
    // The model hears why and answers
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)).toEqual({
      role: 'tool',
      content: JSON.stringify({ error: 'The user denied this tool call.' }),
      tool_call_id: 'c1',
    });
    expect(store.getState().chat.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Okay, I did not write it.' });
  });

  it('Allow once runs the call, and the next call to the tool asks again', async () => {
    const { store, callTool, saveConfig } = setup(askingServer(), [
      { toolCalls: [call('c1', 'write_file', { path: 'a.txt' })] },
      { toolCalls: [call('c2', 'write_file', { path: 'b.txt' })] },
      { text: 'Both written.' },
    ]);
    const run = store.dispatch(sendStreamingMessageWithTools({ content: 'write two files', model: 'm' }) as any);

    await waitingFor(store, ['c1']);
    await store.dispatch(answerToolApproval({ callId: 'c1', decision: 'once' }) as any);
    await waitingFor(store, ['c2']);
    expect(callTool).toHaveBeenCalledTimes(1);
    await store.dispatch(answerToolApproval({ callId: 'c2', decision: 'once' }) as any);
    await run;

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(toolCallsOf(store).map((c) => c.approval)).toEqual(['approved', 'approved']);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('Always allow saves the tool as allowed, releases other waiting calls to it, and stops asking', async () => {
    const { store, callTool, saveConfig } = setup(askingServer(), [
      { toolCalls: [call('c1', 'write_file', { path: 'a.txt' }), call('c2', 'write_file', { path: 'b.txt' }), call('c3', 'delete_file', { path: 'c.txt' })] },
      { toolCalls: [call('c4', 'write_file', { path: 'd.txt' })] },
      { text: 'Done.' },
    ]);
    const run = store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    await waitingFor(store, ['c1', 'c2', 'c3']);
    await store.dispatch(answerToolApproval({ callId: 'c1', decision: 'always' }) as any);

    // Saved for the tool on its server (and kept in the store)
    expect(saveConfig).toHaveBeenCalledWith(expect.objectContaining({ id: 'fs', toolPolicies: { write_file: 'allow' } }));
    expect(store.getState().mcp.servers.fs.toolPolicies).toEqual({ write_file: 'allow' });
    // Both write_file calls run; delete_file still waits
    await waitingFor(store, ['c3']);
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));

    await store.dispatch(answerToolApproval({ callId: 'c3', decision: 'deny' }) as any);
    await run;

    // The next round's write_file ran without asking
    expect(callTool.mock.calls.map((c) => c[1])).toEqual(['write_file', 'write_file', 'write_file']);
    expect(toolCallsOf(store).map((c) => c.approval)).toEqual(['approved', 'approved', 'rejected', undefined]);
  });

  it('never offers a blocked tool, and refuses one called anyway', async () => {
    const server = readyServer('fs', 'Files', [tool('write_file'), tool('read_file')], { write_file: 'block', read_file: 'allow' });
    const { store, requests, callTool } = setup(server, [
      { toolCalls: [call('c1', 'write_file', { path: 'a.txt' })] },
      { text: 'It is blocked.' },
    ]);

    await store.dispatch(sendStreamingMessageWithTools({ content: 'write', model: 'm' }) as any);

    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(['read_file']);
    expect(callTool).not.toHaveBeenCalled();
    expect(store.getState().chat.awaitingApproval).toEqual([]);
    expect(requests[1].messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(String(requests[1].messages.at(-1)!.content)).toContain('blocked');
  });

  it("runs a built-in server's read-only tools without asking", async () => {
    const builtin = readyServer('builtin-fs', 'Filesystem', [tool('read_file'), tool('search_and_replace')], {});
    builtin.config = { ...builtin.config, transport: 'builtin', builtin: true, builtinId: 'filesystem' };
    const { store, callTool } = setup(builtin, [
      { toolCalls: [call('c1', 'read_file', { path: 'a.txt' }), call('c2', 'search_and_replace', { path: 'a.txt' })] },
      { text: 'Done.' },
    ]);
    const run = store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    // read_file ran; search_and_replace writes, so it asks
    await waitingFor(store, ['c2']);
    expect(callTool.mock.calls.map((c) => c[1])).toEqual(['read_file']);
    await store.dispatch(answerToolApproval({ callId: 'c2', decision: 'once' }) as any);
    await run;
    expect(callTool.mock.calls.map((c) => c[1])).toEqual(['read_file', 'search_and_replace']);
  });

  it('Stop while a call waits refuses it and ends the reply', async () => {
    const { store, requests, callTool } = setup(askingServer(), [{ toolCalls: [call('c1', 'write_file')] }, { text: 'never sent' }]);
    const run = store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    await waitingFor(store, ['c1']);
    store.dispatch(abortStreaming());
    await run;

    expect(callTool).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(toolCallsOf(store)[0].approval).toBe('rejected');
    expect(store.getState().chat.awaitingApproval).toEqual([]);
    expect(store.getState().chat.isStreaming).toBe(false);
    // A late answer finds nothing waiting
    await store.dispatch(answerToolApproval({ callId: 'c1', decision: 'once' }) as any);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('clearing the chat while a call waits ends the reply without touching the new chat', async () => {
    const { store, requests, callTool } = setup(askingServer(), [{ toolCalls: [call('c1', 'write_file')] }, { text: 'never sent' }]);
    const run = store.dispatch(sendStreamingMessageWithTools({ content: 'go', model: 'm' }) as any);

    await waitingFor(store, ['c1']);
    store.dispatch(clearMessages());
    await run;

    expect(callTool).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(store.getState().chat.messages).toEqual([]);
    expect(store.getState().chat.awaitingApproval).toEqual([]);
  });
});
