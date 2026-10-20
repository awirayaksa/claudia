// @vitest-environment jsdom
/** Settings → Files → Workspace: browse folders, download, upload into the open folder. */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createWebStore } from '../../store';
import '../../i18n';
import { WorkspaceFiles } from './WorkspaceFiles';

const entry = (path: string, type: 'file' | 'directory', size?: number) => ({
  name: path.split('/').pop(),
  path,
  type,
  ...(size !== undefined ? { size } : {}),
  modifiedAt: '2026-10-20T08:00:00.000Z',
});

describe('workspace files', () => {
  it('opens folders, links downloads and uploads into the open folder', async () => {
    const tree: Record<string, unknown[]> = {
      '': [entry('reports', 'directory')],
      reports: [entry('reports/q3.md', 'file', 4)],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/workspace-files' && (!init?.method || init.method === 'GET')) {
        const dir = url.searchParams.get('path') ?? '';
        return Response.json({ path: dir, entries: tree[dir] ?? [] });
      }
      if (url.pathname === '/api/workspace-files/upload') return Response.json({ path: 'reports/notes.txt', size: 2 }, { status: 201 });
      return Response.json({ error: { code: 'not_found', message: url.pathname } }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <Provider store={createWebStore()}>
        <WorkspaceFiles />
      </Provider>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'reports' }));
    const link = await screen.findByRole('link', { name: 'q3.md' });
    expect(link).toHaveAttribute('href', '/api/workspace-files/content?path=reports%2Fq3.md');

    fireEvent.change(screen.getByTestId('workspace-upload'), { target: { files: [new File(['hi'], 'notes.txt')] } });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/workspace-files/upload?path=reports', expect.objectContaining({ method: 'POST' }))
    );
  });
});
