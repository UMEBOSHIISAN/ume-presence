import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import {
  DefaultPresenceSurface,
  normalizeDefaultPresenceAudioLevel,
} from './components/DefaultPresenceSurface';
import type { PresenceMode } from './presence-director';

const modes: PresenceMode[] = [
  'rest',
  'attention',
  'thinking',
  'speaking',
  'complete',
];

describe('DefaultPresenceSurface', () => {
  test.each(modes)('exposes the %s presence mode semantically', (mode) => {
    const markup = renderToStaticMarkup(
      <DefaultPresenceSurface mode={mode} cue={null} audioLevel={0} />,
    );

    expect(markup).toContain(`default-presence--${mode}`);
    expect(markup).toContain(`data-presence-mode="${mode}"`);
  });

  test('propagates the active PresenceDirector cue', () => {
    const markup = renderToStaticMarkup(
      <DefaultPresenceSurface mode="attention" cue="break" audioLevel={0} />,
    );

    expect(markup).toContain('default-presence--cue-break');
    expect(markup).toContain('data-presence-cue="break"');
  });

  test('clamps invalid and out-of-range audio levels', () => {
    expect(normalizeDefaultPresenceAudioLevel(Number.NaN)).toBe(0);
    expect(normalizeDefaultPresenceAudioLevel(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeDefaultPresenceAudioLevel(-0.2)).toBe(0);
    expect(normalizeDefaultPresenceAudioLevel(0.4)).toBe(0.4);
    expect(normalizeDefaultPresenceAudioLevel(1.8)).toBe(1);
  });

  test('exposes only a bounded audio-level CSS variable', () => {
    const markup = renderToStaticMarkup(
      <DefaultPresenceSurface mode="speaking" cue={null} audioLevel={1.8} />,
    );

    expect(markup).toContain('--default-presence-audio-level:1');
    expect(markup).toContain('--default-presence-speaking-scale:1.08');
    expect(markup).not.toContain('--default-presence-audio-level:1.8');
  });
});
