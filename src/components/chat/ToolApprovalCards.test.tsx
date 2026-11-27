// @vitest-environment jsdom
/** The approval card: what the tool will do, and the answer reaching the waiting tool loop. */
import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { makeChatStore, readyServer, tool } from '../../test/chat-harness';
import { addMessage, setToolApproval } from '../../store/slices/chatSlice';
import { waitForApproval } from '../../services/mcp/tool-approvals';
import { ToolApprovalCards } from './ToolApprovalCards';

afterEach(cleanup);

describe('ToolApprovalCards', () => {
  it('shows the tool, its server and the arguments, and Allow once answers the waiting call', async () => {
    const store = makeChatStore([readyServer('fs', 'Files', [tool('write_file')], {})]);
    store.dispatch(
      addMessage({
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: '2026-11-21T00:00:00.000Z',
        toolCalls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hi"}' } }],
      })
    );
    store.dispatch(setToolApproval({ callId: 'c1', approval: 'pending' }));
    const decision = waitForApproval('c1', { serverId: 'fs', tool: 'write_file' });

    render(
      <Provider store={store}>
        <ToolApprovalCards />
      </Provider>
    );

    const card = screen.getByTestId('tool-approval');
    expect(card.textContent).toContain('write_file');
    expect(card.textContent).toContain('Files');
    expect(card.querySelector('pre')?.textContent).toBe(JSON.stringify({ path: 'a.txt', content: 'hi' }, null, 2));

    fireEvent.click(screen.getByTestId('allow-once'));
    expect(await decision).toBe('once');
    expect((screen.getByTestId('deny-tool') as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows nothing when no call waits', () => {
    const { container } = render(
      <Provider store={makeChatStore()}>
        <ToolApprovalCards />
      </Provider>
    );
    expect(container.innerHTML).toBe('');
  });
});
