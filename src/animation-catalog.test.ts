import { describe, expect, it, vi } from 'vitest';
import {
  ANIMATION_CATALOG,
  ANIMATION_MAP,
  nextAnimation,
  randomAnimation,
} from './animation-catalog';

describe('Persona animation contract', () => {
  it('uses every stable replacement slot exactly once in the catalog', () => {
    expect(Object.values(ANIMATION_CATALOG).sort()).toEqual([
      'celebrate1.vrma',
      'celebrate2.vrma',
      'dance1.vrma',
      'dance2.vrma',
      'greeting.vrma',
      'idle.vrma',
      'talk1.vrma',
      'talk2.vrma',
      'talk3.vrma',
    ]);
    expect(ANIMATION_MAP.IDLE).toEqual(['idle.vrma']);
    expect(ANIMATION_MAP.TALK).toHaveLength(3);
    expect(ANIMATION_MAP.DANCE).toHaveLength(2);
  });

  it('can select every multi-clip category without escaping that category', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(randomAnimation('TALK')).toBe('talk3.vrma');
    expect(randomAnimation('CELEBRATE')).toBe('celebrate2.vrma');
    expect(randomAnimation('DANCE')).toBe('dance2.vrma');
    vi.restoreAllMocks();
  });

  it('cycles through every talking clip without consecutive repeats', () => {
    const first = nextAnimation('TALK');
    const second = nextAnimation('TALK', first);
    const third = nextAnimation('TALK', second);
    const wrapped = nextAnimation('TALK', third);

    expect([first, second, third]).toEqual([
      'talk1.vrma',
      'talk2.vrma',
      'talk3.vrma',
    ]);
    expect(wrapped).toBe(first);
  });
});
