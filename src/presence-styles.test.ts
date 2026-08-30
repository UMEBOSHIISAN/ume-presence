/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('presence CSS contract', () => {
  test.each(['attention', 'thinking', 'complete'])(
    'contains the %s presence selector',
    (mode) => expect(css).toContain(`character-avatar--presence-${mode}`),
  );
  test.each(['greeting', 'complete', 'break'])(
    'contains the %s cue selector',
    (cue) => expect(css).toContain(`character-avatar--cue-${cue}`),
  );
  test.each(['rest', 'attention', 'thinking', 'speaking', 'complete'])(
    'contains the Default Presence %s selector',
    (mode) => expect(css).toContain(`default-presence--${mode}`),
  );
  test('disables presence motion under reduced-motion preference', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.character-avatar__motion');
    expect(reduced).toContain('animation: none');
    expect(reduced).toContain('translate: 0 0');
    expect(reduced).toContain('rotate: 0deg');
  });

  test('overrides every higher-specificity presence motion selector', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.character-avatar--presence-attention .character-avatar__motion');
    expect(reduced).toContain('.character-avatar--presence-thinking .character-avatar__motion');
    expect(reduced).toContain('.character-avatar--presence-complete .character-avatar__motion');
    expect(reduced).toContain('.character-avatar--cue-complete .character-avatar__motion');
    expect(reduced).toContain('.character-avatar--cue-break .character-avatar__motion');
  });

  test('makes Default Presence effectively motionless under reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.default-presence__halo');
    expect(reduced).toContain('.default-presence__ring');
    expect(reduced).toContain('.default-presence__orb');
    expect(reduced).toContain('.default-presence__core');
    expect(reduced).toContain('animation: none');
    expect(reduced).toContain('transition: none');
  });
});
