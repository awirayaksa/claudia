import { describe, it, expect } from 'vitest';
import {
  builtinSkills,
  isBuiltinSkillId,
  parseFrontmatter,
  parseSkillMarkdown,
  resolveSkillCommand,
  resolveSkillInvocation,
  serializeSkill,
  validateSkillId,
} from './skill-core';

describe('frontmatter', () => {
  it('parses name and description and strips quotes', () => {
    const { frontmatter, body } = parseFrontmatter('---\nname: "Code Review"\ndescription: Look: carefully\nother: x\n---\n\nBody here\n');
    expect(frontmatter).toEqual({ name: 'Code Review', description: 'Look: carefully' });
    expect(body).toBe('Body here');
  });

  it('handles CRLF files and files without frontmatter', () => {
    expect(parseFrontmatter('---\r\nname: A\r\n---\r\nB').frontmatter).toEqual({ name: 'A' });
    expect(parseFrontmatter('Just a body')).toEqual({ frontmatter: {}, body: 'Just a body' });
  });

  it('round-trips through serializeSkill', () => {
    const md = serializeSkill({ name: 'My\nSkill', description: 'Does things', body: 'Do {{args}}' });
    expect(md).toBe('---\nname: My Skill\ndescription: Does things\n---\n\nDo {{args}}\n');
    expect(parseSkillMarkdown(md, 'my-skill')).toEqual({
      id: 'my-skill',
      name: 'My Skill',
      description: 'Does things',
      body: 'Do {{args}}',
      builtin: false,
      filePath: null,
    });
  });

  it('falls back to the id when there is no name', () => {
    expect(parseSkillMarkdown('body', 'x', '/s/x.md')).toMatchObject({ name: 'x', description: '', filePath: '/s/x.md' });
  });
});

describe('ids and built-ins', () => {
  it('validates ids', () => {
    expect(() => validateSkillId('code-review2')).not.toThrow();
    for (const bad of ['Code', '1abc', 'a_b', 'a b', '', '../x']) {
      expect(() => validateSkillId(bad)).toThrow(/Invalid skill id/);
    }
  });

  it('lists built-ins without a file', () => {
    const skills = builtinSkills();
    expect(skills.map((s) => s.id)).toEqual(['summarize', 'translate', 'code-review', 'simplify', 'explain']);
    expect(skills.every((s) => s.builtin && s.filePath === null)).toBe(true);
    expect(isBuiltinSkillId('explain')).toBe(true);
    expect(isBuiltinSkillId('mine')).toBe(false);
  });
});

describe('invocation', () => {
  it('fills {{args}}, or appends args when there is no placeholder', () => {
    expect(resolveSkillInvocation('Summarize:\n\n{{args}}', 'the text')).toBe('Summarize:\n\nthe text');
    expect(resolveSkillInvocation('Be terse.', 'hello')).toBe('Be terse.\n\nhello');
    expect(resolveSkillInvocation('Be terse.  ', '')).toBe('Be terse.');
  });

  it('never leaves a literal {{args}} behind', () => {
    expect(resolveSkillInvocation('Summarize:\n\n{{args}}', '')).toBe('Summarize:');
  });

  it('resolves /commands against the skill list', () => {
    const skills = builtinSkills();
    expect(resolveSkillCommand('/explain closures in JS', skills)).toEqual({
      skillPrompt: expect.stringMatching(/closures in JS$/),
      userContent: 'closures in JS',
      skillId: 'explain',
    });
    expect(resolveSkillCommand('/explain', skills)?.userContent).toBe('Invoked /explain');
    expect(resolveSkillCommand('/unknown x', skills)).toBeNull();
    expect(resolveSkillCommand('explain x', skills)).toBeNull();
  });
});
