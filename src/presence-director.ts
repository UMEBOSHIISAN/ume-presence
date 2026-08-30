import type { AnimationType } from './animation-catalog';

export const THINKING_TIMEOUT_MS = 30_000;

export type PresenceMode = 'rest' | 'attention' | 'thinking' | 'speaking' | 'complete';
export type PresenceCue = 'thinking' | 'greeting' | 'complete' | 'break' | 'clear';
export type ActivePresenceCue = Exclude<PresenceCue, 'clear'>;
export type RitualName = 'greeting' | 'work_complete' | 'break';

export interface PresenceDirectorState {
  voice: VoiceState;
  internalSpeechActive: boolean;
  cue: ActivePresenceCue | null;
  previewAnimation: AnimationType | null;
}

export type PresenceAction =
  | { type: 'voice'; voice: VoiceState }
  | { type: 'internal-speech'; active: boolean }
  | { type: 'cue'; cue: PresenceCue }
  | { type: 'preview'; animation: AnimationType }
  | { type: 'clear-preview' };

export interface PresencePresentation {
  animation: AnimationType;
  cue: ActivePresenceCue | null;
  mode: PresenceMode;
  ritual: RitualName | null;
}

const INITIAL_INACTIVE_VOICE = Object.freeze({
  activity: 'idle',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'inactive',
}) as VoiceState;

const RITUAL_BY_CUE = {
  greeting: 'greeting',
  complete: 'work_complete',
  break: 'break',
} as const;

function isRitualCue(
  cue: ActivePresenceCue | null,
): cue is keyof typeof RITUAL_BY_CUE {
  return cue === 'greeting' || cue === 'complete' || cue === 'break';
}

function isExternalSpeaking(voice: VoiceState): boolean {
  return voice.phase === 'active' && voice.activity === 'speaking' && !voice.outputMuted;
}

function isSpeechActive(state: PresenceDirectorState): boolean {
  return state.internalSpeechActive || isExternalSpeaking(state.voice);
}

export function createInitialPresenceState(): PresenceDirectorState {
  return {
    voice: INITIAL_INACTIVE_VOICE,
    internalSpeechActive: false,
    cue: null,
    previewAnimation: null,
  };
}

export function reducePresence(
  state: PresenceDirectorState,
  action: PresenceAction,
): PresenceDirectorState {
  switch (action.type) {
    case 'voice': {
      const becameInactive =
        state.voice.phase !== 'inactive' && action.voice.phase === 'inactive';
      const clearsCue = becameInactive || isExternalSpeaking(action.voice);
      return {
        ...state,
        voice: action.voice,
        cue: clearsCue ? null : state.cue,
        previewAnimation: null,
      };
    }
    case 'internal-speech':
      return action.active
        ? { ...state, internalSpeechActive: true, cue: null, previewAnimation: null }
        : { ...state, internalSpeechActive: false };
    case 'cue':
      if (action.cue === 'clear') return { ...state, cue: null };
      if (isSpeechActive(state)) return state;
      if (action.cue === 'thinking') {
        if (
          state.voice.phase !== 'active' ||
          state.cue !== null ||
          state.previewAnimation !== null
        ) return state;
        return { ...state, cue: action.cue };
      }
      if (isRitualCue(state.cue)) return state;
      return { ...state, cue: action.cue, previewAnimation: null };
    case 'preview':
      return isSpeechActive(state) || isRitualCue(state.cue)
        ? state
        : { ...state, cue: null, previewAnimation: action.animation };
    case 'clear-preview':
      return { ...state, previewAnimation: null };
  }
}

export function selectPresencePresentation(
  state: PresenceDirectorState,
): PresencePresentation {
  const speechActive = isSpeechActive(state);
  const mode: PresenceMode = speechActive
    ? 'speaking'
    : state.cue === 'complete'
      ? 'complete'
      : state.cue === 'thinking'
        ? 'thinking'
        : state.voice.phase === 'active'
          ? 'attention'
          : 'rest';

  const animation: AnimationType = speechActive
    ? 'TALK'
    : state.cue === 'greeting'
      ? 'GREETING'
      : state.previewAnimation ?? 'IDLE';

  return {
    animation,
    cue: speechActive ? null : state.cue,
    mode,
    ritual: state.cue === null ? null : RITUAL_BY_CUE[state.cue as keyof typeof RITUAL_BY_CUE] ?? null,
  };
}
