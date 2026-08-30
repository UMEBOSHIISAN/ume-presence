import type { CSSProperties } from 'react';

import type { ActivePresenceCue, PresenceMode } from '../presence-director';

interface DefaultPresenceSurfaceProps {
  mode: PresenceMode;
  cue: ActivePresenceCue | null;
  audioLevel: number;
}

// eslint-disable-next-line react-refresh/only-export-components -- pure clamp seam used by renderer tests
export function normalizeDefaultPresenceAudioLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}

export function DefaultPresenceSurface({
  mode,
  cue,
  audioLevel,
}: DefaultPresenceSurfaceProps) {
  const safeAudioLevel = normalizeDefaultPresenceAudioLevel(audioLevel);
  const speakingScale = Number((1 + safeAudioLevel * 0.08).toFixed(3));
  const style = {
    '--default-presence-audio-level': safeAudioLevel,
    '--default-presence-speaking-scale': speakingScale,
  } as CSSProperties;
  const classes = [
    'default-presence',
    `default-presence--${mode}`,
    cue ? `default-presence--cue-${cue}` : null,
  ].filter(Boolean).join(' ');

  return (
    <section
      className={classes}
      data-presence-mode={mode}
      data-presence-cue={cue ?? undefined}
      role="img"
      aria-label="UME Presence"
      style={style}
    >
      <div className="default-presence__halo" aria-hidden="true" />
      <div className="default-presence__orb" aria-hidden="true">
        <div className="default-presence__ring" />
        <div className="default-presence__core" />
      </div>
    </section>
  );
}
