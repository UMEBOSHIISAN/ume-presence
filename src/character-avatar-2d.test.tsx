import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import {
  AppFrame,
  CharacterStage,
  createCharacterLoader,
  nextExternalAudioLevel,
  presenceActionForBridgeEvent,
} from './App';
import {
  CharacterAssetFallback,
  CharacterAvatarSurface,
  characterSurfaceFitStyle,
  normalizeCharacterAudioLevel,
  processCharacterBackground,
} from './components/CharacterAvatar2D';

const CHARACTER_SOURCE = 'data:image/webp;base64,UklGRlBSSVZBVEU=';
const fixtureCharacter = {
  id: 'second-character',
  displayName: 'Second Character',
  avatar: {
    type: 'image2d',
    source: CHARACTER_SOURCE,
    accessibleLabel: 'Second Character',
    backgroundMode: 'transparent',
    mouth: {
      xPercent: 42,
      yPercent: 19,
      small: { widthPercent: 1.2, heightPercent: 0.3 },
      open: { widthPercent: 1.9, heightPercent: 0.8 },
    },
  },
} as const;

const activeSpeakingVoice = {
  activity: 'speaking',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'active',
} as const;

const stageProps = {
  animation: 'IDLE' as const,
  audioLevel: 0,
  presenceCue: null,
  presenceMode: 'rest' as const,
  speaking: false,
  talkTurn: 0,
};

describe('createCharacterLoader', () => {
  test('returns one memoized promise and invokes the bridge exactly once', async () => {
    let calls = 0;
    const loadCharacter = createCharacterLoader(() => {
      calls += 1;
      return Promise.resolve(fixtureCharacter);
    });

    const first = loadCharacter();
    const second = loadCharacter();

    expect(first).toBe(second);
    await expect(first).resolves.toBe(fixtureCharacter);
    expect(calls).toBe(1);
  });

  test('memoizes a null bridge result without inventing an identity', async () => {
    let calls = 0;
    const loadCharacter = createCharacterLoader(() => {
      calls += 1;
      return Promise.resolve(null);
    });

    await expect(loadCharacter()).resolves.toBeNull();
    await expect(loadCharacter()).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  test('maps a synchronous bridge throw to one memoized null result', async () => {
    let calls = 0;
    const loadCharacter = createCharacterLoader(() => {
      calls += 1;
      throw new Error('bridge unavailable');
    });

    await expect(loadCharacter()).resolves.toBeNull();
    await expect(loadCharacter()).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  test('maps a bridge rejection to one memoized null result', async () => {
    let calls = 0;
    const loadCharacter = createCharacterLoader(() => {
      calls += 1;
      return Promise.reject(new Error('character unavailable'));
    });

    await expect(loadCharacter()).resolves.toBeNull();
    await expect(loadCharacter()).resolves.toBeNull();
    expect(calls).toBe(1);
  });
});

describe('processCharacterBackground', () => {
  test('preserves transparent source pixels without calling edge removal', () => {
    const source = new Uint8ClampedArray([1, 2, 3, 4]);
    let calls = 0;
    const removeBackground = () => {
      calls += 1;
      return new Uint8ClampedArray([0, 0, 0, 0]);
    };

    const result = processCharacterBackground(
      'transparent',
      source,
      1,
      1,
      removeBackground,
    );

    expect(result).toBe(source);
    expect(calls).toBe(0);
  });

  test('calls edge removal exactly once for edge-connected media', () => {
    const source = new Uint8ClampedArray([1, 2, 3, 4]);
    const processed = new Uint8ClampedArray([1, 2, 3, 0]);
    const calls: Array<[Uint8ClampedArray, number, number]> = [];
    const removeBackground = (
      pixels: Uint8ClampedArray,
      width: number,
      height: number,
    ) => {
      calls.push([pixels, width, height]);
      return processed;
    };

    const result = processCharacterBackground(
      'edge-connected',
      source,
      1,
      1,
      removeBackground,
    );

    expect(result).toBe(processed);
    expect(calls).toEqual([[source, 1, 1]]);
  });
});

describe('characterSurfaceFitStyle', () => {
  test('fits a non-2:3 bitmap while keeping overlays in its intrinsic coordinate box', () => {
    expect(characterSurfaceFitStyle(400, 200)).toEqual({
      aspectRatio: '400 / 200',
      width: 'min(100%, calc(100vh * 400 / 200))',
    });
  });
});

describe('normalizeCharacterAudioLevel', () => {
  test('returns zero when speech is inactive or the level is not finite', () => {
    expect(normalizeCharacterAudioLevel(0.8, false)).toBe(0);
    expect(normalizeCharacterAudioLevel(Number.NaN, true)).toBe(0);
    expect(normalizeCharacterAudioLevel(Number.POSITIVE_INFINITY, true)).toBe(0);
  });

  test('clamps finite speaking levels to the renderer range', () => {
    expect(normalizeCharacterAudioLevel(-0.2, true)).toBe(0);
    expect(normalizeCharacterAudioLevel(0.4, true)).toBe(0.4);
    expect(normalizeCharacterAudioLevel(1.8, true)).toBe(1);
  });
});

describe('nextExternalAudioLevel', () => {
  test('clears stale levels outside an active unmuted session', () => {
    expect(nextExternalAudioLevel(0.8, {
      ...activeSpeakingVoice,
      phase: 'inactive',
    })).toBe(0);
    expect(nextExternalAudioLevel(0.8, {
      ...activeSpeakingVoice,
      outputMuted: true,
    })).toBe(0);
    expect(nextExternalAudioLevel(0.8, activeSpeakingVoice)).toBe(0.8);
  });
});

describe('presenceActionForBridgeEvent', () => {
  test('restores a ritual cue received from the renderer snapshot', () => {
    expect(presenceActionForBridgeEvent({
      type: 'presence-cue',
      cue: 'break',
    })).toEqual({ type: 'cue', cue: 'break' });
  });
});

describe('CharacterAvatarSurface', () => {
  test('exposes only closed presence mode and cue classes', () => {
    const markup = renderToStaticMarkup(
      <CharacterAvatarSurface
        animation="IDLE"
        character={fixtureCharacter}
        mouthState="closed"
        presenceCue="break"
        presenceMode="attention"
        talkTurn={0}
      />,
    );

    expect(markup).toContain('character-avatar--presence-attention');
    expect(markup).toContain('character-avatar--cue-break');
    expect(markup).toContain('data-presence-mode="attention"');
    expect(markup).toContain('data-presence-cue="break"');
  });

  test('renders a motion wrapper with the bounded speech level', () => {
    const markup = renderToStaticMarkup(
      <CharacterAvatarSurface
        character={fixtureCharacter}
        animation="TALK"
        mouthState="open"
        motionLevel={0.4}
        talkTurn={1}
      />,
    );

    expect(markup).toContain(
      'class="character-avatar__motion character-avatar__motion--talk"',
    );
    expect(markup).toContain('data-motion-level="0.4"');
    expect(markup).toContain('--character-audio-level:0.4');
    expect(markup).toContain('--character-speech-lift:-2.6px');
  });

  test('keeps the closed source unobstructed', () => {
    const closed = renderToStaticMarkup(
      <CharacterAvatarSurface
        character={fixtureCharacter}
        animation="IDLE"
        mouthState="closed"
        talkTurn={0}
      />,
    );

    expect(closed).toContain('data-mouth-state="closed"');
    expect(closed).not.toContain('character-mouth--small');
    expect(closed).not.toContain('character-mouth--open');
  });

  test('renders only the requested small mouth overlay', () => {
    const small = renderToStaticMarkup(
      <CharacterAvatarSurface
        character={fixtureCharacter}
        animation="TALK"
        mouthState="small"
        talkTurn={1}
      />,
    );

    expect(small).toContain('character-mouth character-mouth--small');
    expect(small).not.toContain('character-mouth--open');
  });

  test('renders pack-driven open-mouth markup without exposing the data URL', () => {
    const markup = renderToStaticMarkup(
      <CharacterAvatarSurface
        character={fixtureCharacter}
        animation="TALK"
        mouthState="open"
        talkTurn={1}
      />,
    );

    expect(markup).toContain('aria-label="Second Character"');
    expect(markup).toContain('--mouth-x:42%');
    expect(markup).toContain('--mouth-y:19%');
    expect(markup).toContain('--mouth-small-width:1.2%');
    expect(markup).toContain('--mouth-small-height:0.3%');
    expect(markup).toContain('--mouth-open-width:1.9%');
    expect(markup).toContain('--mouth-open-height:0.8%');
    expect(markup).toContain('character-mouth--open');
    expect(markup).toContain('data-animation="TALK"');
    expect(markup).toContain('data-talk-turn="1"');
    expect(markup).toContain('character-avatar--talk');
    expect(markup).not.toContain('data-avatar-source=');
    expect(markup).not.toContain(CHARACTER_SOURCE);
    expect(markup).not.toMatch(/private-character/i);
  });

  test('renders a second pack through the same generic data-only surface', () => {
    const sampleCharacter = {
      ...fixtureCharacter,
      id: 'sample-character',
      displayName: 'Sample Character',
    } as const;
    const markup = renderToStaticMarkup(
      <CharacterAvatarSurface
        character={sampleCharacter}
        animation="TALK"
        mouthState="open"
        talkTurn={1}
      />,
    );

    expect(markup).toContain('<span class="character-mouth character-mouth--open"');
    expect(markup).not.toContain('character-avatar__eye-overlay');
    expect(markup).not.toContain('<img');
  });

  test.each(['GREETING', 'CELEBRATE', 'DANCE'] as const)(
    'maps %s to a generic motion class',
    (animation) => {
      const markup = renderToStaticMarkup(
        <CharacterAvatarSurface
          character={fixtureCharacter}
          animation={animation}
          mouthState="closed"
          talkTurn={0}
        />,
      );

      expect(markup).toContain(`character-avatar--${animation.toLowerCase()}`);
    },
  );
});

describe('generic character fallbacks', () => {
  test('does not report an unavailable character while loading is unsettled', () => {
    const loading = renderToStaticMarkup(
      <CharacterStage character={undefined} {...stageProps} />,
    );

    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('role="alert"');
    expect(loading).not.toContain('Local character is unavailable.');
  });

  test('shows the built-in Default Presence when no pack is selected', () => {
    const presence = renderToStaticMarkup(
      <CharacterStage character={null} {...stageProps} />,
    );

    expect(presence).toContain('class="default-presence default-presence--rest"');
    expect(presence).toContain('data-presence-mode="rest"');
    expect(presence).not.toContain('role="alert"');
    expect(presence).not.toContain('Local character is unavailable.');
    expect(presence).not.toContain('Second Character');
    expect(presence).not.toMatch(/private-character/i);
  });

  test('shows a generic asset diagnostic instead of a second broken image', () => {
    const fallback = renderToStaticMarkup(<CharacterAssetFallback />);

    expect(fallback).toContain('role="alert"');
    expect(fallback).toContain('Local character asset is unavailable.');
    expect(fallback).not.toContain('<img');
    expect(fallback).not.toMatch(/private-character/i);
  });
});

describe('character stage indicators', () => {
  test.each(['warning', 'error'] as const)(
    'preserves the %s indicator around a pack-driven character',
    (indicator) => {
      const marked = renderToStaticMarkup(
        <AppFrame indicator={indicator}>
          <CharacterStage character={fixtureCharacter} {...stageProps} />
        </AppFrame>,
      );

      expect(marked).toContain(`class="app app--${indicator}"`);
      expect(marked).toContain('aria-label="Second Character"');
    },
  );
});
