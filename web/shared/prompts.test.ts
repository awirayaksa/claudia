import { describe, it, expect } from 'vitest';
import { fillSystemVariables, fillTemplate, templateVariables } from './prompts';

const NOW = new Date('2026-03-05T14:07:00Z');

describe('prompt templates', () => {
  it('lists user variables once, with defaults, in order', () => {
    expect(templateVariables('Dear {{ name }}, re {{topic:the plan}}. {{name}} {{CURRENT_DATE}} {{tone: warm }}')).toEqual([
      { name: 'name', default: '' },
      { name: 'topic', default: 'the plan' },
      { name: 'tone', default: 'warm' },
    ]);
    expect(templateVariables('No placeholders, {single} braces, {{ }} and {{!bad}}')).toEqual([]);
  });

  it('fills values, defaults and system variables', () => {
    const out = fillTemplate(
      'Hi {{name}} about {{topic:the plan}} on {{CURRENT_DATE}} ({{CURRENT_WEEKDAY}}), from {{USER_NAME}}. {{missing}}',
      { name: 'Ada' },
      { userName: 'Bob', now: NOW, timeZone: 'UTC' }
    );
    expect(out).toBe('Hi Ada about the plan on 2026-03-05 (Thursday), from Bob. ');
  });

  it('only replaces system variables in system prompts', () => {
    expect(fillSystemVariables('Today is {{CURRENT_DATE}}; keep {{this}} and {{name:x}}.', { now: NOW, timeZone: 'UTC' })).toBe(
      'Today is 2026-03-05; keep {{this}} and {{name:x}}.'
    );
  });
});
