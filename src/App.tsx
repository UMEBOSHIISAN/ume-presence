import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { CharacterAvatar2D } from './components/CharacterAvatar2D';
import { DefaultPresenceSurface } from './components/DefaultPresenceSurface';
import type { AnimationType } from './animation-catalog';
import { nextIndicator, type VisualIndicator } from './error-indicator';
import {
  createInitialPresenceState,
  reducePresence,
  selectPresencePresentation,
  THINKING_TIMEOUT_MS,
  type ActivePresenceCue,
  type PresenceAction,
  type PresenceMode,
} from './presence-director';
import { createSpeechPlayback } from './speech-playback';

// The memoized Promise survives React StrictMode's development effect replay.
// eslint-disable-next-line react-refresh/only-export-components
export function createCharacterLoader(
  getCharacter: () => Promise<RendererCharacter | null>,
) {
  let pending: Promise<RendererCharacter | null> | null = null;
  return () => {
    pending ??= Promise.resolve()
      .then(getCharacter)
      .catch(() => null);
    return pending;
  };
}

const loadCharacterOnce = createCharacterLoader(() =>
  window.personaBridge?.getCharacter() ?? Promise.resolve(null),
);

export function AppFrame({
  children,
  indicator,
}: {
  children: ReactNode;
  indicator: VisualIndicator;
}) {
  return (
    <main className={indicator ? `app app--${indicator}` : 'app'}>
      {children}
    </main>
  );
}

interface CharacterStageProps {
  animation: AnimationType;
  audioLevel: number;
  character: RendererCharacter | null | undefined;
  presenceCue: ActivePresenceCue | null;
  presenceMode: PresenceMode;
  speaking: boolean;
  talkTurn: number;
}

export function CharacterStage({
  animation,
  audioLevel,
  character,
  presenceCue,
  presenceMode,
  speaking,
  talkTurn,
}: CharacterStageProps) {
  if (character === undefined) {
    return <section className="character-avatar" aria-busy="true" />;
  }
  if (character === null) {
    return (
      <DefaultPresenceSurface
        mode={presenceMode}
        cue={presenceCue}
        audioLevel={audioLevel}
      />
    );
  }

  return (
    <CharacterAvatar2D
      animation={animation}
      audioLevel={audioLevel}
      character={character}
      presenceCue={presenceCue}
      presenceMode={presenceMode}
      speaking={speaking}
      talkTurn={talkTurn}
    />
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- pure state helper used by renderer tests
export function nextExternalAudioLevel(level: number, voice: VoiceState): number {
  return voice.phase === 'active' && !voice.outputMuted ? level : 0;
}

// eslint-disable-next-line react-refresh/only-export-components -- pure event router used by renderer tests
export function presenceActionForBridgeEvent(
  event: AvatarBridgeEvent,
): PresenceAction | null {
  if (event.type === 'state') return { type: 'voice', voice: event.state };
  if (event.type === 'animation') {
    return { type: 'preview', animation: event.animation };
  }
  if (event.type === 'presence-cue') return { type: 'cue', cue: event.cue };
  return null;
}

export function App() {
  const [character, setCharacter] = useState<
    RendererCharacter | null | undefined
  >(undefined);
  const [presenceState, dispatchPresence] = useReducer(
    reducePresence,
    undefined,
    createInitialPresenceState,
  );
  const presentation = selectPresencePresentation(presenceState);
  const [audioLevel, setAudioLevel] = useState(0);
  const [indicator, setIndicator] = useState<VisualIndicator>(null);
  const [talkTurn, setTalkTurn] = useState(0);
  const [internalSpeechLevel, setInternalSpeechLevel] = useState(0);
  const previousSpeaking = useRef(false);

  useEffect(() => {
    let active = true;
    void loadCharacterOnce().then((loadedCharacter) => {
      if (active) setCharacter(loadedCharacter);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge) return;
    const handleBridgeEvent = (event: AvatarBridgeEvent) => {
      const presenceAction = presenceActionForBridgeEvent(event);
      if (presenceAction) dispatchPresence(presenceAction);
      if (event.type === 'state') {
        setAudioLevel((level) => nextExternalAudioLevel(level, event.state));
      } else if (event.type === 'audio-level') {
        setAudioLevel(event.level);
      } else if (event.type === 'indicator') {
        setIndicator((current) => nextIndicator(current, event));
      }
    };
    void bridge.getSnapshot().then((events) => {
      for (const event of events) handleBridgeEvent(event);
    });
    return bridge.subscribe(handleBridgeEvent);
  }, []);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge) return;
    const playback = createSpeechPlayback({
      onActive: (active) => dispatchPresence({ type: 'internal-speech', active }),
      onLevel: setInternalSpeechLevel,
      reportResult: (result) => bridge.reportSpeechResult(result),
    });
    const unsubscribe = bridge.subscribeSpeech((payload) => {
      void playback.play(payload).catch(() => {});
    });
    const unsubscribeCancellation = bridge.subscribeSpeechCancellation((id) => {
      playback.stop(id);
    });
    bridge.reportSpeechReady();
    return () => {
      unsubscribe();
      unsubscribeCancellation();
      playback.stop();
    };
  }, []);

  const speaking = presentation.mode === 'speaking';
  const effectiveAudioLevel = presenceState.internalSpeechActive
    ? internalSpeechLevel
    : audioLevel;

  useEffect(() => {
    const startedSpeaking = speaking && !previousSpeaking.current;
    previousSpeaking.current = speaking;
    if (startedSpeaking) setTalkTurn((turn) => turn + 1);

  }, [speaking]);

  useEffect(() => {
    if (presenceState.cue !== 'thinking') return;
    const timer = window.setTimeout(
      () => dispatchPresence({ type: 'cue', cue: 'clear' }),
      THINKING_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [presenceState.cue]);

  return (
    <AppFrame indicator={indicator}>
      <CharacterStage
        animation={presentation.animation}
        audioLevel={effectiveAudioLevel}
        character={character}
        presenceCue={presentation.cue}
        presenceMode={presentation.mode}
        speaking={speaking}
        talkTurn={talkTurn}
      />
    </AppFrame>
  );
}
