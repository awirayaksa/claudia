// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToolFileCards, filesOfResults } from './ToolFileCards';

const files = vi.hoisted(() => ({ openLocal: vi.fn(), revealLocal: vi.fn() }));
vi.mock('../../platform', () => ({ getPlatform: () => ({ files }) }));

afterEach(cleanup);

const a = { path: 'C:\Docs\budget.xlsx', name: 'budget.xlsx', size: 100 };
const b = { path: 'C:\Docs\deck.pptx', name: 'deck.pptx', size: 2048 };

describe('filesOfResults', () => {
  it('lists each file once, with its latest size, skipping failed calls', () => {
    const results = [
      { files: [a] },
      { files: [b] },
      { files: [{ ...a, size: 300 }] },
      { files: [{ ...b, size: 1 }], isError: true },
      {},
    ];
    expect(filesOfResults(results)).toEqual([b, { ...a, size: 300 }]);
    expect(filesOfResults(undefined)).toEqual([]);
  });
});

describe('ToolFileCards', () => {
  it('opens a file and shows it in its folder', async () => {
    files.openLocal.mockResolvedValue(undefined);
    files.revealLocal.mockResolvedValue(undefined);
    render(<ToolFileCards files={[a]} />);
    expect(screen.getByText('budget.xlsx')).toBeTruthy();
    expect(screen.getByText('XLSX')).toBeTruthy();
    fireEvent.click(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Show in folder'));
    expect(files.openLocal).toHaveBeenCalledWith(a.path);
    expect(files.revealLocal).toHaveBeenCalledWith(a.path);
  });

  it('says why a file could not be opened', async () => {
    files.openLocal.mockRejectedValue(new Error('The file was moved or deleted.'));
    render(<ToolFileCards files={[b]} />);
    fireEvent.click(screen.getByText('Open'));
    await waitFor(() => expect(screen.getByText('The file was moved or deleted.')).toBeTruthy());
  });
});
