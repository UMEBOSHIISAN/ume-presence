/// <reference types="vite/client" />

type VoicePhase = 'inactive' | 'starting' | 'active' | 'stopping';
type VoiceActivity = 'idle' | 'listening' | 'speaking';

interface RendererCharacterMouthSize {
  readonly widthPercent: number;
  readonly heightPercent: number;
}

interface RendererCharacterMouth {
  readonly xPercent: number;
  readonly yPercent: number;
  readonly small: RendererCharacterMouthSize;
  readonly open: RendererCharacterMouthSize;
}

interface RendererCharacterAvatar {
  readonly type: 'image2d';
  readonly source: `data:image/${'png' | 'webp'};base64,${string}`;
  readonly accessibleLabel: string;
  readonly backgroundMode: 'transparent' | 'edge-connected';
  readonly mouth: RendererCharacterMouth;
}

interface RendererCharacter {
  readonly id: string;
  readonly displayName: string;
  readonly avatar: RendererCharacterAvatar;
}

interface VoiceState {
  activity: VoiceActivity;
  microphoneMuted: boolean;
  outputMuted: boolean;
  phase: VoicePhase;
}

interface AudioListenerStatus {
  available: boolean;
  capturing: boolean;
  error?: string;
  monitoring: boolean;
  source: string | null;
}

type AvatarBridgeEvent =
  | { type: 'state'; state: VoiceState }
  | { type: 'audio-level'; level: number }
  | { type: 'animation'; animation: 'IDLE' | 'GREETING' | 'TALK' | 'CELEBRATE' | 'DANCE' }
  | {
      type: 'presence-cue';
      cue: 'thinking' | 'greeting' | 'complete' | 'break' | 'clear';
    }
  | { type: 'indicator'; indicator: 'warning' | 'error' | 'clear' }
  | { type: 'listener-status'; status: AudioListenerStatus }
  | { type: 'bridge-status'; connected: boolean };

interface SpeechPayload {
  id: string;
  wavBytes: Uint8Array;
}

type SpeechResult =
  | { id: string; status: 'started' }
  | { id: string; status: 'completed' }
  | { id: string; status: 'failed'; message: string };

interface Window {
  personaBridge?: {
    getCharacter(): Promise<RendererCharacter | null>;
    getSnapshot(): Promise<AvatarBridgeEvent[]>;
    hide(): void;
    subscribe(listener: (event: AvatarBridgeEvent) => void): () => void;
    subscribeSpeech(listener: (payload: SpeechPayload) => void): () => void;
    subscribeSpeechCancellation(listener: (id: string) => void): () => void;
    reportSpeechResult(result: SpeechResult): void;
    reportSpeechReady(): void;
  };
}
