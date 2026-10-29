// @vitest-environment jsdom
/** A long paste becomes a "Pasted text" chip that sends the whole text; a short one is pasted as usual. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

afterEach(cleanup);
import { Provider } from 'react-redux';
import { ChatInput } from '@/components/chat/ChatInput';
import { setPreferences } from '@/store/slices/settingsSlice';
import { setPlatform } from '@/platform';
import { createWebPlatform } from '../platform/web.platform';
import { createWebStore } from '../store';
import '../i18n';

const uploaded: File[] = [];

beforeAll(() => {
  window.matchMedia ??= ((query: string) =>
    ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) as unknown as MediaQueryList);
  const base = createWebPlatform({});
  setPlatform({
    ...base,
    files: {
      ...base.files,
      upload: async (file: File) => {
        uploaded.push(file);
        return { id: `f${uploaded.length}`, type: 'file' as const, name: file.name, size: file.size, mimeType: file.type };
      },
    },
  });
});

function setup() {
  const store = createWebStore();
  const onSend = vi.fn();
  render(
    <Provider store={store}>
      <ChatInput onSend={onSend} />
    </Provider>
  );
  return { store, onSend, box: screen.getByRole('textbox') as HTMLTextAreaElement };
}

const paste = (el: HTMLElement, text: string) =>
  fireEvent.paste(el, { clipboardData: { items: [], getData: (type: string) => (type === 'text/plain' ? text : '') } });

describe('pasting long text', () => {
  it('attaches it as a chip that can be viewed, put back inline, or sent', async () => {
    const { onSend, box } = setup();
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n');
    await act(async () => {
      paste(box, long);
    });
    const chip = await screen.findByTestId('pasted-text-chip');
    expect(chip).toHaveTextContent('Pasted text 1');
    expect(chip).toHaveTextContent('60 lines');
    expect(box.value).toBe('');
    expect(await uploaded.at(-1)!.text()).toBe(long);

    // View it, then put it back in the message box
    fireEvent.click(chip);
    expect(screen.getByTestId('pasted-text')).toHaveTextContent('line 59');
    fireEvent.click(screen.getByRole('button', { name: 'Put it in the message instead' }));
    await waitFor(() => expect(box.value).toBe(long));
    expect(screen.queryByTestId('pasted-text-chip')).toBeNull();

    // Pasted again and sent: it goes as an attachment
    await act(async () => {
      paste(box, 'x'.repeat(2500));
    });
    fireEvent.change(box, { target: { value: 'Summarize this' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(onSend.mock.calls[0][1]).toEqual([expect.objectContaining({ name: 'Pasted text 2.txt' })]);
  });

  it('pastes short text, and long text when turned off, as usual', async () => {
    const { store, box } = setup();
    const before = uploaded.length;
    await act(async () => {
      paste(box, 'just a few words');
    });
    act(() => {
      store.dispatch(setPreferences({ pasteLongTextAsFile: false }));
    });
    await act(async () => {
      paste(box, 'y'.repeat(5000));
    });
    expect(uploaded.length).toBe(before);
    expect(screen.queryByTestId('pasted-text-chip')).toBeNull();
  });
});
