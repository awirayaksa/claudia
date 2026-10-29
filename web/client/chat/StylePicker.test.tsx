// @vitest-environment jsdom
/** The composer's style menu lists the built-ins and one's own styles, and picks one. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { createWebStore } from '../store';
import '../i18n';
import { StylePicker } from './StylePicker';

afterEach(cleanup);

describe('style picker', () => {
  it('shows the chosen style and picks another', async () => {
    const styles = [
      { id: 'normal', name: 'Normal', description: '', instructions: '', scope: 'builtin', ownerName: null, canEdit: false, canManage: false },
      { id: 'concise', name: 'Concise', description: '', instructions: 'x', scope: 'builtin', ownerName: null, canEdit: false, canManage: false },
      { id: 's1', name: 'Pirate', description: '', instructions: 'Arr', scope: 'mine', ownerName: null, canEdit: true, canManage: true },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ styles })));
    const onChange = vi.fn();
    render(
      <Provider store={createWebStore()}>
        <MemoryRouter>
          <StylePicker value="concise" onChange={onChange} />
        </MemoryRouter>
      </Provider>
    );
    expect(await screen.findByText('Concise')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Writing style' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Pirate' }).catch(() => screen.getByText('Pirate')));
    expect(onChange).toHaveBeenCalledWith('s1');
  });
});
