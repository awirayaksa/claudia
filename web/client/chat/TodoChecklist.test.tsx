// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import '../i18n';
import reducer, { runEvent, runFollowed } from './run-slice';
import { TaskChip, TodoChecklist } from './TodoChecklist';
import { taskOutcome } from './task-notify';
import type { MessageNode } from '@/types/turn.types';

afterEach(cleanup);

const node = (id: string, role: MessageNode['role'], extra: Partial<MessageNode> = {}): MessageNode => ({
  id,
  chatId: 'c',
  parentId: null,
  role,
  parts: [],
  status: 'streaming',
  createdAt: '2026-11-15T00:00:00.000Z',
  ...extra,
});

describe('agent task checklist', () => {
  it('shows progress and each step', () => {
    render(
      <TodoChecklist
        running
        items={[
          { content: 'Read the receipts', status: 'completed' },
          { content: 'Build the sheet', status: 'in_progress' },
          { content: 'Summarize', status: 'pending' },
        ]}
      />
    );
    expect(screen.getByTestId('task-progress').textContent).toBe('1 of 3 done');
    expect(screen.getByText('Build the sheet').closest('li')?.getAttribute('data-status')).toBe('in_progress');
  });

  it('links the task folder to the workspace browser', () => {
    render(
      <MemoryRouter>
        <TaskChip folder="tasks/2026-11-15-receipts" />
      </MemoryRouter>
    );
    expect(screen.getByTestId('task-chip').getAttribute('href')).toBe('/settings?tab=files&dir=tasks%2F2026-11-15-receipts');
  });

  it('replaces the plan in place as the run updates it, and says how the task ended', () => {
    let s = reducer({}, runFollowed({ chatId: 'c', runId: 'r' }));
    const events = [
      { type: 'message.created' as const, message: node('u', 'user', { status: 'completed', task: { folder: 'tasks/x' } }) },
      { type: 'message.created' as const, message: node('a', 'assistant') },
      { type: 'message.delta' as const, messageId: 'a', text: 'Working' },
      { type: 'message.todo' as const, messageId: 'a', items: [{ content: 'One', status: 'in_progress' as const }] },
      { type: 'message.todo' as const, messageId: 'a', items: [{ content: 'One', status: 'completed' as const }] },
    ];
    events.forEach((event, i) => {
      s = reducer(s, runEvent({ chatId: 'c', envelope: { seq: i + 1, event } }));
    });
    expect(s.c.nodes.a.parts).toEqual([
      { type: 'todo', items: [{ content: 'One', status: 'completed' }] },
      { type: 'text', text: 'Working' },
    ]);
    const done = { ...s.c, nodes: { ...s.c.nodes, a: { ...s.c.nodes.a, status: 'completed' as const } } };
    expect(taskOutcome(done)).toEqual({ title: 'Task done', body: '1/1 steps · tasks/x' });
    expect(taskOutcome({ ...done, nodes: { ...done.nodes, a: { ...done.nodes.a, status: 'error' } } })?.title).toBe('Task stopped with a problem');
    // A plain chat reply is not a task
    expect(taskOutcome({ ...done, nodes: { a: done.nodes.a } })).toBeNull();
  });
});
