import { describe, it, expect } from 'vitest';
import { VISUAL_EXPLANATIONS_PROMPT, withVisualExplanations } from './visual-explanations';

describe('withVisualExplanations', () => {
  it('puts the diagram guidance before the user\'s prompt', () => {
    expect(withVisualExplanations('Be brief.', true)).toBe(`${VISUAL_EXPLANATIONS_PROMPT}\n\nBe brief.`);
    expect(withVisualExplanations('  ', true)).toBe(VISUAL_EXPLANATIONS_PROMPT);
  });

  it('is on for settings saved before it existed', () => {
    expect(withVisualExplanations('', undefined)).toBe(VISUAL_EXPLANATIONS_PROMPT);
  });

  it('leaves the user\'s prompt alone when turned off', () => {
    expect(withVisualExplanations('Be brief.', false)).toBe('Be brief.');
    expect(withVisualExplanations('', false)).toBe('');
  });
});
