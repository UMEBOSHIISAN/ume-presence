import { useEffect, useRef, useState, type CSSProperties } from 'react';

import type { AnimationType } from '../animation-catalog';
import type { ActivePresenceCue, PresenceMode } from '../presence-director';
import {
  nextCharacterMouthState,
  type CharacterMouthState,
} from '../character-mouth-state';
import { removeEdgeConnectedBackground } from '../edge-background-alpha';

type BackgroundRemoval = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
) => Uint8ClampedArray;

// This pure seam maps validated intrinsic dimensions onto the viewport-fit surface.
// eslint-disable-next-line react-refresh/only-export-components
export function characterSurfaceFitStyle(
  width: number,
  height: number,
): CSSProperties {
  return {
    aspectRatio: `${width} / ${height}`,
    width: `min(100%, calc(100vh * ${width} / ${height}))`,
  };
}

interface CharacterAvatarSurfaceProps {
  animation: AnimationType;
  character: RendererCharacter;
  mouthState: CharacterMouthState;
  motionLevel?: number;
  presenceCue?: ActivePresenceCue | null;
  presenceMode?: PresenceMode;
  talkTurn: number;
}

interface CharacterAvatar2DProps {
  animation: AnimationType;
  audioLevel: number;
  character: RendererCharacter;
  presenceCue: ActivePresenceCue | null;
  presenceMode: PresenceMode;
  speaking: boolean;
  talkTurn: number;
}

// This exported pure seam keeps background-mode behavior testable without DOM image decoding.
// eslint-disable-next-line react-refresh/only-export-components
export function processCharacterBackground(
  backgroundMode: RendererCharacter['avatar']['backgroundMode'],
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  removeBackground: BackgroundRemoval = removeEdgeConnectedBackground,
) {
  if (backgroundMode === 'transparent') return pixels;
  return removeBackground(pixels, width, height);
}

export function CharacterAssetFallback() {
  return (
    <div className="character-avatar__fallback" role="alert">
      Local character asset is unavailable.
    </div>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- intentional helper export used by renderer tests
export function normalizeCharacterAudioLevel(
  level: number,
  speaking: boolean,
): number {
  if (!speaking || !Number.isFinite(level)) return 0;
  return Math.min(1, Math.max(0, level));
}

export function CharacterAvatarSurface({
  animation,
  character,
  mouthState,
  motionLevel,
  presenceCue = null,
  presenceMode = 'rest',
  talkTurn,
}: CharacterAvatarSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [surfaceFitStyle, setSurfaceFitStyle] = useState<CSSProperties>({});

  const mouthStyle = {
    '--mouth-x': `${character.avatar.mouth.xPercent}%`,
    '--mouth-y': `${character.avatar.mouth.yPercent}%`,
    '--mouth-small-width': `${character.avatar.mouth.small.widthPercent}%`,
    '--mouth-small-height': `${character.avatar.mouth.small.heightPercent}%`,
    '--mouth-open-width': `${character.avatar.mouth.open.widthPercent}%`,
    '--mouth-open-height': `${character.avatar.mouth.open.heightPercent}%`,
  } as CSSProperties;
  const safeMotionLevel = normalizeCharacterAudioLevel(motionLevel ?? 0, true);
  const motionStyle = {
    ...mouthStyle,
    '--character-audio-level': safeMotionLevel,
    '--character-speech-lift': `${-(1 + safeMotionLevel * 4)}px`,
    '--character-speech-tilt': `${safeMotionLevel * 0.8}deg`,
    '--character-speech-scale': String(1 + safeMotionLevel * 0.006),
  } as CSSProperties;
  const presenceClasses = [
    `character-avatar--presence-${presenceMode}`,
    presenceCue ? `character-avatar--cue-${presenceCue}` : null,
  ].filter(Boolean).join(' ');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    setLoadFailed(false);
    setSurfaceFitStyle({});
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      try {
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        setSurfaceFitStyle(
          characterSurfaceFitStyle(image.naturalWidth, image.naturalHeight),
        );
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('2D canvas context is unavailable.');
        context.drawImage(image, 0, 0);
        if (character.avatar.backgroundMode === 'edge-connected') {
          const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
          imageData.data.set(
            processCharacterBackground(
              character.avatar.backgroundMode,
              imageData.data,
              canvas.width,
              canvas.height,
            ),
          );
          context.putImageData(imageData, 0, 0);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    };
    image.onerror = () => {
      if (!cancelled) setLoadFailed(true);
    };
    image.src = character.avatar.source;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [character.avatar.backgroundMode, character.avatar.source]);

  return (
    <section
      className={`character-avatar character-avatar--${animation.toLowerCase()} ${presenceClasses}`}
      data-animation={animation}
      data-mouth-state={mouthState}
      data-presence-cue={presenceCue ?? undefined}
      data-presence-mode={presenceMode}
      data-talk-turn={talkTurn}
      style={surfaceFitStyle}
    >
      <div
        className={
          animation === 'TALK'
            ? 'character-avatar__motion character-avatar__motion--talk'
            : 'character-avatar__motion'
        }
        data-motion-level={safeMotionLevel}
        style={motionStyle}
      >
        {loadFailed ? (
          <CharacterAssetFallback />
        ) : (
          <canvas
            ref={canvasRef}
            className="character-avatar__art"
            aria-label={character.avatar.accessibleLabel}
            role="img"
          />
        )}
        {mouthState !== 'closed' && (
          <span
            className={`character-mouth character-mouth--${mouthState}`}
            aria-hidden="true"
          />
        )}
      </div>
    </section>
  );
}

export function CharacterAvatar2D({
  animation,
  audioLevel,
  character,
  presenceCue,
  presenceMode,
  speaking,
  talkTurn,
}: CharacterAvatar2DProps) {
  const [mouthState, setMouthState] = useState<CharacterMouthState>('closed');

  useEffect(() => {
    setMouthState((current) =>
      nextCharacterMouthState(current, audioLevel, speaking),
    );
  }, [audioLevel, speaking]);

  return (
    <CharacterAvatarSurface
      animation={animation}
      character={character}
      mouthState={mouthState}
      motionLevel={normalizeCharacterAudioLevel(audioLevel, speaking)}
      presenceCue={presenceCue}
      presenceMode={presenceMode}
      talkTurn={talkTurn}
    />
  );
}
