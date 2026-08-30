import { describe, expect, test } from 'vitest';

import { nextCharacterMouthState } from './character-mouth-state';

describe('nextCharacterMouthState', () => {
  test('forces closed outside the speaking gate', () => {
    expect(nextCharacterMouthState('open', 1, false)).toBe('closed');
  });

  test('maps audible levels to small and open', () => {
    expect(nextCharacterMouthState('closed', 0.03, true)).toBe('small');
    expect(nextCharacterMouthState('small', 0.1, true)).toBe('open');
  });

  test('preserves the existing hysteresis around the open threshold', () => {
    expect(nextCharacterMouthState('open', 0.06, true)).toBe('open');
    expect(nextCharacterMouthState('small', 0.06, true)).toBe('small');
  });

  test('returns to the exact closed source state in silence', () => {
    expect(nextCharacterMouthState('open', 0.008, true)).toBe('closed');
  });

  test('clamps invalid and out-of-range levels', () => {
    expect(nextCharacterMouthState('open', Number.NaN, true)).toBe('closed');
    expect(nextCharacterMouthState('closed', -1, true)).toBe('closed');
    expect(nextCharacterMouthState('closed', 2, true)).toBe('open');
  });
});
